const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("fallback settings default off and persist only sanitized selections", async (t) => {
  const listeners = new Map();
  const { storage } = installBrowserGlobals(t, {
    window: {
      electronAPI: undefined,
      addEventListener: (event, listener) => listeners.set(event, listener),
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "fallback-settings-" });
  const { useSettingsStore, initializeSettings } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const state = useSettingsStore.getState();
  assert.equal(state.cleanupFallbackEnabled, false);
  assert.equal(state.transcriptionFallbackEnabled, false);
  assert.deepEqual(state.cleanupFallbackModels, []);
  state.setCleanupFallbackEnabled(true);
  state.setCleanupFallbackModels([
    { provider: "groq", model: "model", apiKey: "secret", baseUrl: "https://example.com" },
    { provider: "groq", model: "model" },
  ]);
  assert.equal(storage.getItem("cleanupFallbackEnabled"), "true");
  assert.equal(storage.getItem("cleanupFallbackModels"), '[{"provider":"groq","model":"model"}]');
  await initializeSettings();
  const onStorage = listeners.get("storage");
  onStorage({
    storageArea: storage,
    key: "transcriptionFallbackModels",
    newValue: '[{"provider":"whisper","model":"base","apiKey":"secret"}]',
  });
  assert.deepEqual(useSettingsStore.getState().transcriptionFallbackModels, [
    { provider: "whisper", model: "base" },
  ]);
  onStorage({ storageArea: storage, key: "transcriptionFallbackModels", newValue: "invalid" });
  assert.deepEqual(useSettingsStore.getState().transcriptionFallbackModels, []);
  onStorage({ storageArea: storage, key: "cleanupFallbackEnabled", newValue: "false" });
  assert.equal(useSettingsStore.getState().cleanupFallbackEnabled, false);
});
