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
  const match = /net::(ERR_[A-Z_]+)/.exec(String(error.message || ""));
  return match ? match[1] : null;
}

function classifyTransportError(error) {
  return PRE_CONNECT_CODES.has(errorCode(error)) ? "failed" : "unknown";
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

module.exports = { classifyTransportError, classifyHttpStatus, classifyProviderError };
