/**
 * Serialises access to the single local llama-server.
 *
 * There is one server process and it answers one request at a time, so every
 * local inference in the app is really competing for one slot. Until now that
 * was expressed as a boolean that threw ("Already processing a request"), which
 * meant a multi-minute batch job made dictation fail outright for its duration.
 *
 * The slot deliberately covers *starting* the server as well as inferring on it:
 * `serverManager.start` stops the running process when the model changes, so a
 * caller that switches models outside the slot would SIGTERM another caller's
 * in-flight request.
 *
 * Leases exist for the one path that cannot hold the slot across a single
 * function call — the renderer streams chat-agent tokens straight from
 * llama-server's HTTP port, so it acquires over IPC and releases when the stream
 * ends. A lease is therefore bounded by a max hold and released when its owning
 * webContents goes away; a renderer that crashes must not own the server.
 */

const PRIORITIES = { interactive: 0, batch: 1 };

const DEFAULT_INTERACTIVE_TIMEOUT_MS = 180_000;
const DEFAULT_LEASE_MAX_HOLD_MS = 120_000;
const DEFAULT_MAX_BATCH_WAITERS = 4;

function schedulerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class LocalInferenceScheduler {
  constructor({
    maxBatchWaiters = DEFAULT_MAX_BATCH_WAITERS,
    interactiveTimeoutMs = DEFAULT_INTERACTIVE_TIMEOUT_MS,
    leaseMaxHoldMs = DEFAULT_LEASE_MAX_HOLD_MS,
    onLeaseReclaimed = null,
  } = {}) {
    this._held = false;
    this._waiters = [];
    this._seq = 0;
    this._leases = new Map();
    this._maxBatchWaiters = maxBatchWaiters;
    this._interactiveTimeoutMs = interactiveTimeoutMs;
    this._leaseMaxHoldMs = leaseMaxHoldMs;
    this._onLeaseReclaimed = onLeaseReclaimed;
  }

  get busy() {
    return this._held;
  }

  get waiting() {
    return this._waiters.length;
  }

  /**
   * @returns {Promise<() => void>} release, idempotent
   */
  acquire({ priority = "batch", timeoutMs, signal } = {}) {
    const rank = PRIORITIES[priority] ?? PRIORITIES.batch;

    if (signal?.aborted) {
      return Promise.reject(schedulerError("Aborted", "LOCAL_INFERENCE_ABORTED"));
    }

    if (!this._held && this._waiters.length === 0) {
      this._held = true;
      return Promise.resolve(this._makeRelease());
    }

    if (rank === PRIORITIES.batch) {
      const queuedBatch = this._waiters.filter((w) => w.rank === PRIORITIES.batch).length;
      if (queuedBatch >= this._maxBatchWaiters) {
        return Promise.reject(
          schedulerError("Local inference queue is full", "LOCAL_INFERENCE_QUEUE_FULL")
        );
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = { rank, seq: this._seq++, resolve, reject, timer: null, onAbort: null };

      const remove = () => {
        const i = this._waiters.indexOf(waiter);
        if (i !== -1) this._waiters.splice(i, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.onAbort) signal.removeEventListener("abort", waiter.onAbort);
      };
      waiter.remove = remove;

      const effectiveTimeout =
        timeoutMs ?? (rank === PRIORITIES.interactive ? this._interactiveTimeoutMs : undefined);
      if (effectiveTimeout != null) {
        waiter.timer = setTimeout(() => {
          remove();
          reject(
            schedulerError(
              "The local model is busy with another request",
              "LOCAL_INFERENCE_BUSY"
            )
          );
        }, effectiveTimeout);
        if (typeof waiter.timer.unref === "function") waiter.timer.unref();
      }

      if (signal) {
        waiter.onAbort = () => {
          remove();
          reject(schedulerError("Aborted", "LOCAL_INFERENCE_ABORTED"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      this._waiters.push(waiter);
    });
  }

  async runExclusive(options, fn) {
    const release = await this.acquire(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async acquireLease({ owner, priority = "interactive", timeoutMs, signal } = {}) {
    const release = await this.acquire({ priority, timeoutMs, signal });
    const id = `lease-${this._seq++}`;
    const lease = { id, owner, release, timer: null };

    if (this._leaseMaxHoldMs != null) {
      lease.timer = setTimeout(() => {
        if (this._leases.delete(id)) {
          release();
          this._onLeaseReclaimed?.(id, owner);
        }
      }, this._leaseMaxHoldMs);
      if (typeof lease.timer.unref === "function") lease.timer.unref();
    }

    this._leases.set(id, lease);
    return { id, owner };
  }

  releaseLease(id) {
    const lease = this._leases.get(id);
    if (!lease) return false;
    this._leases.delete(id);
    if (lease.timer) clearTimeout(lease.timer);
    lease.release();
    return true;
  }

  releaseLeasesForOwner(owner) {
    let released = 0;
    for (const lease of [...this._leases.values()]) {
      if (lease.owner === owner && this.releaseLease(lease.id)) released++;
    }
    return released;
  }

  _makeRelease() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this._held = false;
      this._grantNext();
    };
  }

  _grantNext() {
    if (this._held || this._waiters.length === 0) return;

    let best = 0;
    for (let i = 1; i < this._waiters.length; i++) {
      const w = this._waiters[i];
      const b = this._waiters[best];
      if (w.rank < b.rank || (w.rank === b.rank && w.seq < b.seq)) best = i;
    }

    const waiter = this._waiters[best];
    waiter.remove();
    this._held = true;
    waiter.resolve(this._makeRelease());
  }
}

module.exports = { LocalInferenceScheduler, PRIORITIES };
