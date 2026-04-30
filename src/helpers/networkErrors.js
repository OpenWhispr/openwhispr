const debugLogger = require("./debugLogger");

const MESSAGES = {
  "streaming.errors.cloudUnreachable.dnsBlocked":
    "DNS isn't resolving openwhispr.com — an ad blocker or filter may be blocking it.",
  "streaming.errors.cloudUnreachable.refused": "Connection was refused — likely a firewall or VPN.",
  "streaming.errors.cloudUnreachable.timeout":
    "Network timed out — VPN, captive portal, or unstable connection.",
  "streaming.errors.cloudUnreachable.tls":
    "TLS handshake failed — check your system clock or for a corporate proxy.",
  "streaming.errors.cloudUnreachable.generic": "Network request failed. Check your connection.",
};

const CODE_TO_KEY = {
  ENOTFOUND: "streaming.errors.cloudUnreachable.dnsBlocked",
  ECONNREFUSED: "streaming.errors.cloudUnreachable.refused",
  ECONNRESET: "streaming.errors.cloudUnreachable.refused",
  UND_ERR_SOCKET: "streaming.errors.cloudUnreachable.refused",
  ETIMEDOUT: "streaming.errors.cloudUnreachable.timeout",
  UND_ERR_CONNECT_TIMEOUT: "streaming.errors.cloudUnreachable.timeout",
  CERT_HAS_EXPIRED: "streaming.errors.cloudUnreachable.tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "streaming.errors.cloudUnreachable.tls",
  DEPTH_ZERO_SELF_SIGNED_CERT: "streaming.errors.cloudUnreachable.tls",
};

const NAME_TO_KEY = {
  TimeoutError: "streaming.errors.cloudUnreachable.timeout",
  AbortError: "streaming.errors.cloudUnreachable.timeout",
};

function classifyNetworkError(err) {
  if (!err) return { isNetworkError: false };
  const code = err.code || err.cause?.code;
  if (code && CODE_TO_KEY[code]) {
    return { code, messageKey: CODE_TO_KEY[code], isNetworkError: true };
  }
  if (err.name && NAME_TO_KEY[err.name]) {
    return { code: err.name, messageKey: NAME_TO_KEY[err.name], isNetworkError: true };
  }
  return { isNetworkError: false };
}

function getMessage(messageKey) {
  return MESSAGES[messageKey] || MESSAGES["streaming.errors.cloudUnreachable.generic"];
}

function classifyAndLog(err, url) {
  const classified = classifyNetworkError(err);
  if (!classified.isNetworkError) return classified;
  let host;
  let urlPath;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    urlPath = parsed.pathname;
  } catch {
    // url may be missing/invalid — log without host metadata
  }
  debugLogger.warn("Network error", { code: classified.code, host, urlPath }, "network");
  return classified;
}

module.exports = {
  classifyNetworkError,
  getMessage,
  classifyAndLog,
};
