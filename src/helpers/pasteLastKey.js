// Pure helpers for the paste-last hotkey storage sentinel.
//
// Storage uses a "none" sentinel so we can tell "user explicitly cleared the
// binding" apart from "never set" (empty env var). Without the sentinel, a
// user-cleared key would be indistinguishable from first launch, and the
// registrar would re-bind Alt+Shift+Z on every startup.
//
// Callers outside environment.js should never touch the sentinel directly —
// use these helpers or the wrappers on EnvironmentManager.

const PASTE_LAST_DISABLED = "none";
const PASTE_LAST_DEFAULT = "Alt+Shift+Z";

// Transform a user-facing key value into the form written to storage.
// Empty / null / undefined → the disabled sentinel.
function normalizeForStorage(key) {
  if (key === "" || key === null || key === undefined) {
    return PASTE_LAST_DISABLED;
  }
  return key;
}

// Transform a stored value into the form surfaced to the renderer / UI.
// The disabled sentinel becomes empty string (UI treats it as "no binding").
function normalizeForRenderer(stored) {
  if (stored === PASTE_LAST_DISABLED) return "";
  return stored || "";
}

// Given the stored value, decide what the main-process startup should do:
// - "none" → user disabled it, skip registration
// - ""     → never set, register the default
// - other  → register that value
function resolveStartupKey(stored) {
  if (stored === PASTE_LAST_DISABLED) return null;
  return stored || PASTE_LAST_DEFAULT;
}

module.exports = {
  PASTE_LAST_DEFAULT,
  PASTE_LAST_DISABLED,
  normalizeForStorage,
  normalizeForRenderer,
  resolveStartupKey,
};
