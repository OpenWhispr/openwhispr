// A prepared value not taken within this window is disposed: prepare fires on
// main-process guesses (toggle key-down) that the renderer may decline, and a
// forgotten prepared stream would otherwise hold the mic open indefinitely.
export const PREPARED_MAX_AGE_MS = 10000;

export const disposePreparedCapture = (prepared) => {
  if (!prepared) return;
  try {
    if (prepared.recorder && prepared.recorder.state !== "inactive") {
      // Detach before stop: the recorder's final dataavailable fires async and
      // would otherwise repopulate the chunks array after it is cleared.
      prepared.recorder.ondataavailable = null;
      prepared.recorder.stop();
    }
  } catch {
    // Recorder already torn down by the browser; the stream stop below still runs.
  }
  if (prepared.chunks) prepared.chunks.length = 0;
  prepared.stream?.getTracks?.().forEach((track) => track.stop());
};

export class PreparedMicCapture {
  constructor({
    dispose = disposePreparedCapture,
    maxAgeMs = PREPARED_MAX_AGE_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    this.dispose = dispose;
    this.maxAgeMs = maxAgeMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.generation = 0;
    this.prepared = null;
    this.pending = null;
    this.expiryTimer = null;
  }

  prepare(acquire) {
    if (this.prepared) return Promise.resolve(this.prepared);
    if (this.pending) return this.pending;

    const generation = this.generation;
    const pending = Promise.resolve()
      .then(acquire)
      .then((prepared) => {
        if (generation !== this.generation) {
          this.dispose(prepared);
          return null;
        }
        this.prepared = prepared;
        this._armExpiry();
        return prepared;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });

    this.pending = pending;
    return pending;
  }

  async take() {
    if (this.pending) {
      try {
        await this.pending;
      } catch {
        // The caller can fall back to a normal acquisition.
      }
    }
    const prepared = this.prepared;
    this.prepared = null;
    this.generation += 1;
    this._clearExpiry();
    return prepared;
  }

  cancel() {
    this.generation += 1;
    this._clearExpiry();
    this.dispose(this.prepared);
    this.prepared = null;
    this.pending = null;
  }

  _armExpiry() {
    this._clearExpiry();
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      this.cancel();
    }, this.maxAgeMs);
  }

  _clearExpiry() {
    if (this.expiryTimer !== null) {
      this.clearTimer(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}
