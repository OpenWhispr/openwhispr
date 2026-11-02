const crypto = require("crypto");

// Settings keeps up to nine panels loaded, and several can show the same credentials.
// Identical checks share one request while it runs, and a Connected answer is reused for
// ten minutes. A failure is never reused, so the next ask, Retry included, reaches the
// provider again.
const CONNECTED_TTL_MS = 10 * 60 * 1000;
const CHECK_FIELDS = [
  "scope",
  "provider",
  "apiKey",
  "baseUrl",
  "model",
  "clientId",
  "clientSecret",
  "environment",
  "tenant",
];

// Everything that decides a check's answer. Only this digest is kept, never a credential.
function checkKey(config) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(CHECK_FIELDS.map((field) => config?.[field] ?? null)))
    .digest("hex");
}

function createConnectionCheckCache({ ttlMs = CONNECTED_TTL_MS, now = Date.now } = {}) {
  const inFlight = new Map();
  const connectedUntil = new Map();
  return function cachedCheck(config, check) {
    const key = checkKey(config);
    if (now() < (connectedUntil.get(key) ?? 0)) return Promise.resolve({ success: true });
    connectedUntil.delete(key);
    let running = inFlight.get(key);
    if (!running) {
      // Started a microtask later, so even a check that throws at once is stored first and
      // removed when it settles.
      running = Promise.resolve()
        .then(check)
        .then((result) => {
          if (result?.success) connectedUntil.set(key, now() + ttlMs);
          return result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, running);
    }
    return running;
  };
}

module.exports = { CONNECTED_TTL_MS, createConnectionCheckCache };
