const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadStore(t, electronAPI) {
  installBrowserGlobals(t, {
    initialStorage: { voiceAgentKey: "F9", translationKey: "F10" },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-registered-hotkey-setter-test-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  return vite.ssrLoadModule("/stores/settingsStore.ts");
}

// Settings and onboarding show main's reason for a refused Voice Assistant or
// Translation hotkey (e.g. a missing Windows key listener), not a generic retry.
test("a refused assistant or translation hotkey reports main's reason and keeps the old key", async (t) => {
  const reason = '"Control+Super" needs the Windows key listener.';
  const { useSettingsStore } = await loadStore(t, {
    updateVoiceAgentHotkey: async () => ({ success: false, message: reason }),
    updateTranslationHotkey: async () => ({ success: false }),
  });
  const store = useSettingsStore.getState();

  assert.deepEqual(await store.setVoiceAgentKey("Control+Super"), {
    success: false,
    message: reason,
  });
  assert.deepEqual(await store.setTranslationKey("RightControl"), {
    success: false,
    message: undefined,
  });
  assert.equal(useSettingsStore.getState().voiceAgentKey, "F9");
  assert.equal(useSettingsStore.getState().translationKey, "F10");
});

test("an accepted assistant hotkey is saved", async (t) => {
  const { useSettingsStore } = await loadStore(t, {
    updateVoiceAgentHotkey: async () => ({ success: true }),
  });

  assert.deepEqual(await useSettingsStore.getState().setVoiceAgentKey("Alt+Space"), {
    success: true,
  });
  assert.equal(useSettingsStore.getState().voiceAgentKey, "Alt+Space");
  assert.equal(globalThis.localStorage.getItem("voiceAgentKey"), "Alt+Space");
});
