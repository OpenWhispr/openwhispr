// Mirrors the DOMException `net.fetch` throws on abort, so transports that
// abort by hand (the ffmpeg child, a queued upload slot) reject with the same
// shape and callers can branch uniformly on `error.name === "AbortError"`.
function createAbortError(message = "Aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

module.exports = { createAbortError };
