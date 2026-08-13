// Pure resolver for the "auto-learn-changed" IPC sync. Coerces the raw IPC
// value to boolean and reports whether it differs from the current state, so
// the handler can ignore repeated same-value syncs (#1080).
function applyAutoLearnSetting(current, incoming) {
  const enabled = !!incoming;
  return { changed: enabled !== !!current, enabled };
}

module.exports = { applyAutoLearnSetting };
