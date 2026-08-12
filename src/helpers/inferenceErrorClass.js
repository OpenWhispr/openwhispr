/**
 * Sorts an inference failure into transient / genuine / fatal.
 *
 * The multi-pass runner reacts very differently to each: transient failures are
 * retried, genuine ones leave a visible gap marker in the notes, fatal ones
 * abort the job. Getting that wrong is expensive in one direction — a gap marker
 * is a permanent hole in the user's notes — so anything unrecognised is treated
 * as transient. A retry costs seconds; a wrong gap marker silently loses part of
 * a call, which is the exact failure this whole feature exists to prevent.
 */

const TRANSIENT_CODES = new Set([
  "LOCAL_INFERENCE_BUSY",
  "LOCAL_INFERENCE_QUEUE_FULL",
  "LLAMA_REQUEST_FAILED",
  "LLAMA_BAD_STATUS",
]);

// A request that already burned the full timeout, or a server that was killed
// while loading, is not a transient blip — retrying it three more times means
// tens of minutes of the same thrash. Retried, but barely.
const SLOW_CODES = new Set([
  "LLAMA_REQUEST_TIMEOUT",
  "LLAMA_START_FAILED",
  "LLAMA_START_TIMEOUT",
]);

const GENUINE_CODES = new Set(["LOCAL_CONTEXT_EXCEEDED", "EMPTY_RESPONSE"]);

const FATAL_CODES = new Set([
  "MODEL_NOT_DOWNLOADED",
  "LLAMASERVER_NOT_FOUND",
  "MODEL_NOT_FOUND",
  "LOCAL_INFERENCE_ABORTED",
]);

// Only needed for errors whose code was lost before reaching us.
const SLOW_PATTERNS = [/timed out/i, /died during startup/i, /failed to start within/i];

const TRANSIENT_PATTERNS = [
  /socket hang up/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /request failed/i,
];

function classifyInferenceError(error) {
  const code = error?.code;
  if (FATAL_CODES.has(code)) return "fatal";
  if (GENUINE_CODES.has(code)) return "genuine";
  if (SLOW_CODES.has(code)) return "slow";
  if (TRANSIENT_CODES.has(code)) return "transient";

  const message = typeof error === "string" ? error : error?.message || "";
  // Matched by message too, so a code lost in a rewrap cannot silently restore
  // the four-attempt policy these codes exist to prevent.
  if (SLOW_PATTERNS.some((p) => p.test(message))) return "slow";
  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) return "transient";

  return "transient";
}

module.exports = { classifyInferenceError, TRANSIENT_CODES, SLOW_CODES, GENUINE_CODES, FATAL_CODES };
