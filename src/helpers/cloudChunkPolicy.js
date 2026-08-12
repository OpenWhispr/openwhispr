const { createAbortError } = require("./abortError");
const { formatTimestamp } = require("./speakerMerge");
const { i18nMain } = require("./i18nMain");

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

// A teardown aborts every sibling still on the wire; those failures are
// self-inflicted, so the sibling's attempt is refunded rather than charged.
// Bounded per chunk so repeated teardowns can't retry forever.
const CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS = 3;

// Above this failed/total ratio the "transcript" is more hole than content;
// returning success would silently persist a fragment (15/19 chunks lost once
// shipped a 16-minute transcript of a 73-minute file as a normal note).
const CLOUD_CHUNK_MAX_LOSS_RATIO = 0.5;

// A 422 NO_SPEECH response is a valid empty segment, not an upload failure.
// Keep it distinct from null (failed) and response objects (transcribed) so
// silence neither consumes the loss budget nor creates a missing-audio marker.
const SILENT_CHUNK = Symbol("silent-cloud-chunk");

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

// Fatal TLS alerts and HTTP/2/QUIC protocol errors poison every stream on the
// connection, so these force the teardown through the cooldown — which exists
// to absorb bursts of ordinary failures, not to keep a provably sick pool
// alive. Chromium's fetch rejections carry the net::ERR_* name only in the
// message, never a structured code.
const POISONED_CONNECTION_RE = /net::ERR_(SSL|HTTP2|QUIC)_/;

function isConnectionPoisoningFailure(err) {
  return POISONED_CONNECTION_RE.test(err?.message ?? "");
}

// True when the failure was (very likely) our own pool teardown aborting this
// chunk's in-flight body: a teardown happened during the attempt and the
// request died at the transport level. An HTTP answer or business code proves
// the request outlived the teardown, and a timeout is the chunk's own failure.
function isTeardownCollateral(err, { timedOut = false, teardownsDuringAttempt = 0 } = {}) {
  return teardownsDuringAttempt > 0 && !timedOut && isNetworkLevelFailure(err, { timedOut });
}

function createTeardownGate(cooldownMs = CLOUD_POOL_TEARDOWN_COOLDOWN_MS, now = Date.now) {
  let lastAt = -Infinity;
  return (force = false) => {
    const at = now();
    if (!force && at - lastAt < cooldownMs) return false;
    lastAt = at;
    return true;
  };
}

function summarizeChunkResults(results) {
  const responses = [];
  let failedChunks = 0;
  let silentChunks = 0;

  for (const result of results) {
    if (result == null) {
      failedChunks++;
    } else if (result === SILENT_CHUNK) {
      silentChunks++;
    } else {
      responses.push(result);
    }
  }

  return { responses, failedChunks, silentChunks };
}

// Joins surviving chunk texts in order and marks every failed span with an
// explicit gap (consecutive failures collapse into one marker), so a partial
// transcript reads as partial instead of seamlessly wrong. Silent segments are
// omitted, and a known input duration clamps the final gap to its real end. The
// marker is read by users and pasted by dictation, so it is localized like the
// [Speaker N] labels in transcriptFormatter.
function assembleChunkTranscript(results, segmentDurationSeconds, totalDurationSeconds) {
  const pieces = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i] === SILENT_CHUNK) continue;
    if (results[i] != null) {
      pieces.push(results[i].text);
      continue;
    }
    const gapStart = i;
    while (i + 1 < results.length && results[i + 1] == null) i++;
    const gapEnd = (i + 1) * segmentDurationSeconds;
    pieces.push(
      i18nMain.t("transcript.missingAudio", {
        from: formatTimestamp(gapStart * segmentDurationSeconds),
        to: formatTimestamp(
          Number.isFinite(totalDurationSeconds) && totalDurationSeconds > 0
            ? Math.min(gapEnd, totalDurationSeconds)
            : gapEnd
        ),
      })
    );
  }
  return pieces.join(" ").replace(/\s+/g, " ").trim();
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
  CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS,
  CLOUD_CHUNK_MAX_LOSS_RATIO,
  SILENT_CHUNK,
  FATAL_CHUNK_CODES,
  isTransientChunkError,
  isNetworkLevelFailure,
  isConnectionPoisoningFailure,
  isTeardownCollateral,
  summarizeChunkResults,
  assembleChunkTranscript,
  chunkRetryDelayMs,
  abortableSleep,
  createTeardownGate,
  createUploadSlots,
};
