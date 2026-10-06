// Codes that mean the request never left this machine. Everything else
// (reset, timeout, abort, unknown) may have reached the provider, so it is
// reported as "unknown" rather than risking a duplicate on retry.
const PRE_CONNECT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_CONNECTION_REFUSED",
  "ERR_ADDRESS_UNREACHABLE",
]);

function errorCode(error) {
  if (!error) return null;
  if (typeof error.code === "string") return error.code;
  if (typeof error.cause?.code === "string") return error.cause.code;
  const match = /net::(ERR_[A-Z0-9_]+)/.exec(String(error.message || ""));
  return match ? match[1] : null;
}

function classifyTransportError(error) {
  return PRE_CONNECT_CODES.has(errorCode(error)) ? "failed" : "unknown";
}

// The code a failed request reports: never its message, which can quote the
// URL. Electron's net.fetch carries "net::ERR_…" in the message only.
function transportErrorCode(error) {
  return errorCode(error) ?? (error?.name === "TimeoutError" ? "timeout" : "network_error");
}

// Whether a code came from transportErrorCode rather than from the provider:
// Node's (ECONNRESET), Chromium's (ERR_CONNECTION_RESET), undici's
// (UND_ERR_*), a timeout or an unnamed network error. Provider codes are
// lower case, so they never match.
function isTransportErrorCode(code) {
  return /^(E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|timeout|network_error)$/.test(code ?? "");
}

// Retry-After in seconds. An HTTP-date (or anything else) is no wait to honour.
function retryAfterMs(header) {
  if (header === null || header === undefined || header === "") return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

// A 4xx is the provider refusing the request. A 5xx (or anything unexpected)
// may come after the provider acted, so it must not be reported as not sent.
function classifyHttpStatus(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400 && status < 500) return "failed";
  return "unknown";
}

// Provider error bodies (e.g. Slack's ok:false) prove nothing unless the
// provider documents the code as a rejection that happens before acting.
function classifyProviderError(code, definiteRejections) {
  return typeof code === "string" && definiteRejections.has(code) ? "failed" : "unknown";
}

module.exports = {
  classifyTransportError,
  classifyHttpStatus,
  classifyProviderError,
  transportErrorCode,
  isTransportErrorCode,
  retryAfterMs,
};
