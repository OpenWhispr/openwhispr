// Mirrors the DOMException that `net.fetch`/`fetch` throw on abort, so manual
// transports (http.request, WebSocket, ffmpeg child) reject with the same shape
// and callers can branch uniformly on `error.name === "AbortError"`.
function createAbortError(message = "Aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

module.exports = { createAbortError };
