const { createAbortError } = require("./abortError");

// Retry/backoff/concurrency policy for the chunked cloud upload path (#1326).
// Kept free of electron imports so the rules stay unit-testable.
//
// The transient/deterministic split mirrors createApiRetryStrategy in
// src/utils/retry.ts; the main process is CJS and that module is TS, so the
// rule is restated rather than imported. It deliberately diverges on 429:
// there it means rate limiting and retries, here it is the account's word
// limit and never clears within a job.

// A dead upload must fail well before the peer's 1–4 min idle teardown does it
// for us, but a healthy ~3.84MB chunk on a slow uplink needs real headroom.
const CLOUD_UPLOAD_TIMEOUT_MS = 120_000;
const CLOUD_CHUNK_MAX_ATTEMPTS = 3;
// Chunk bodies on the wire app-wide. Previously 5 per job with no cross-job
// ceiling, so a user retry ran ~6 concurrent ~4MB bodies; a lone job is
// unchanged, and dictation can no longer be starved by a batch upload.
const CLOUD_CHUNK_GLOBAL_CONCURRENCY = 5;

const CLOUD_CHUNK_BACKOFF_BASE_MS = 5_000;
const CLOUD_CHUNK_BACKOFF_FACTOR = 3;
const CLOUD_CHUNK_BACKOFF_MAX_MS = 45_000;
const CLOUD_CHUNK_BACKOFF_JITTER_MS = 1_000;

// Dropping the connection pool is session-wide, so it also aborts healthy
// sibling uploads. A wedged connection fails every in-flight chunk at once, so
// collapse that burst into one teardown instead of letting each failure
// sacrifice its peers — and its peers' retries in turn.
const CLOUD_POOL_TEARDOWN_COOLDOWN_MS = 30_000;

// Codes that doom the whole job, not just one chunk: retrying the siblings can
// only burn time and quota.
const FATAL_CHUNK_CODES = new Set(["AUTH_EXPIRED", "LIMIT_REACHED"]);

const NON_RETRYABLE_CHUNK_CODES = new Set([...FATAL_CHUNK_CODES, "NO_SPEECH_DETECTED"]);

function isTransientChunkError(err) {
  if (NON_RETRYABLE_CHUNK_CODES.has(err.code)) return false;
  return !err.statusCode || err.statusCode >= 500;
}

// True when the request never got an HTTP answer — the signal that the
// connection pool (not the server) is the suspect and should be torn down
// before the next attempt. Errors carrying a statusCode or a business code
// prove the connection works.
function isNetworkLevelFailure(err, { timedOut = false } = {}) {
  return timedOut || (!err.statusCode && !err.code);
}

function createTeardownGate(cooldownMs = CLOUD_POOL_TEARDOWN_COOLDOWN_MS, now = Date.now) {
  let lastAt = -Infinity;
  return () => {
    const at = now();
    if (at - lastAt < cooldownMs) return false;
    lastAt = at;
    return true;
  };
}

function chunkRetryDelayMs(attempt, random = Math.random) {
  const base = Math.min(
    CLOUD_CHUNK_BACKOFF_BASE_MS * CLOUD_CHUNK_BACKOFF_FACTOR ** (attempt - 1),
    CLOUD_CHUNK_BACKOFF_MAX_MS
  );
  return base + Math.floor(random() * CLOUD_CHUNK_BACKOFF_JITTER_MS);
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Counting semaphore shared by every chunked job. acquire() resolves to a
// release function; a queued waiter whose signal aborts rejects and forfeits
// its place without consuming a slot.
function createUploadSlots(max) {
  let active = 0;
  const waiters = [];

  const admit = () => {
    while (active < max && waiters.length) {
      const waiter = waiters.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      active++;
      waiter.resolve(makeRelease());
    }
  };

  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      admit();
    };
  };

  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(createAbortError());
      if (active < max) {
        active++;
        return Promise.resolve(makeRelease());
      }
      return new Promise((resolve, reject) => {
        const waiter = { settled: false, resolve };
        if (signal) {
          const onAbort = () => {
            if (waiter.settled) return;
            waiter.settled = true;
            reject(createAbortError());
          };
          signal.addEventListener("abort", onAbort, { once: true });
          waiter.resolve = (release) => {
            signal.removeEventListener("abort", onAbort);
            resolve(release);
          };
        }
        waiters.push(waiter);
      });
    },
    get activeCount() {
      return active;
    },
  };
}

module.exports = {
  CLOUD_UPLOAD_TIMEOUT_MS,
  CLOUD_CHUNK_MAX_ATTEMPTS,
  CLOUD_CHUNK_GLOBAL_CONCURRENCY,
  CLOUD_POOL_TEARDOWN_COOLDOWN_MS,
  FATAL_CHUNK_CODES,
  isTransientChunkError,
  isNetworkLevelFailure,
  chunkRetryDelayMs,
  abortableSleep,
  createTeardownGate,
  createUploadSlots,
};
