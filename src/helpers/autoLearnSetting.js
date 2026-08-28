function coerceToBoolean(value) {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "false" || trimmed === "0" || trimmed === "off" || trimmed === "no" || trimmed === "") {
      return false;
    }
    if (trimmed === "true" || trimmed === "1" || trimmed === "on" || trimmed === "yes") {
      return true;
    }
  }
  return Boolean(value);
}

// Pure resolver for the "auto-learn-changed" IPC sync. Coerces the raw IPC
// value to boolean and reports whether it differs from the current state, so
// the handler can ignore repeated same-value syncs (#1080).
function applyAutoLearnSetting(current, incoming) {
  const enabled = coerceToBoolean(incoming);
  const currentEnabled = coerceToBoolean(current);
  return { changed: enabled !== currentEnabled, enabled };
}

module.exports = { applyAutoLearnSetting };
