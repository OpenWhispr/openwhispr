const { BYOK_API_KEYS } = require("../../src/config/secretKeys");

// Shared fake secret-key bridge for settingsStore credential tests: per-key
// getters/savers over an in-memory values map plus cross-owner change
// broadcasts. The default save records the value, notifies listeners and parks
// a pending publication request in `saves` (the awaited-publication behavior
// the store under test relies on); a custom `onSave` replaces the whole save
// outcome instead (no version bump, no notification, no pending request).
function createFakeSecretApi({ values = new Map(), onSave } = {}) {
  const listeners = new Set();
  const saves = [];
  const versions = new Map();
  const api = Object.fromEntries(
    BYOK_API_KEYS.flatMap((k) => [
      [k.get, async () => values.get(k.storeKey) ?? ""],
      [
        k.save,
        (key) => {
          if (onSave) return onSave(k.storeKey, key);
          values.set(k.storeKey, key);
          const version = (versions.get(k.storeKey) ?? 0) + 1;
          versions.set(k.storeKey, version);
          for (const callback of listeners) callback({ key: k.storeKey, version });
          return new Promise((resolve) => saves.push({ field: k.storeKey, resolve }));
        },
      ],
    ])
  );
  api.onSecretKeyChanged = (callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  return { api, listeners, saves, versions };
}

module.exports = { createFakeSecretApi };
