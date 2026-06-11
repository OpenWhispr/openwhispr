// Resolves how long the local cleanup model stays loaded after its last use.
// A value of 0 means never unload while the app is open. Invalid or negative
// values fall back to the default so a bad setting cannot disable cleanup.
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function resolveIdleTimeoutMs(env = process.env) {
  const raw = env.CLEANUP_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.floor(value);
}

module.exports = { DEFAULT_IDLE_TIMEOUT_MS, resolveIdleTimeoutMs };
