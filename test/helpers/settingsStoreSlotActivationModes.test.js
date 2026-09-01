const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("per-slot activation modes default to tap and persist through their setters", async (t) => {
  const notified = [];
  const { storage } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        notifySlotActivationModeChanged: (slot, mode) => notified.push({ slot, mode }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-slot-activation-modes-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");

  const state = useSettingsStore.getState();
  assert.equal(state.voiceAgentActivationMode, "tap");
  assert.equal(state.translationActivationMode, "tap");

  state.setVoiceAgentActivationMode("push");
  state.setTranslationActivationMode("bogus");

  assert.equal(useSettingsStore.getState().voiceAgentActivationMode, "push");
  assert.equal(useSettingsStore.getState().translationActivationMode, "tap");
  assert.equal(storage.getItem("voiceAgentActivationMode"), "push");
  assert.equal(storage.getItem("translationActivationMode"), "tap");
  assert.deepEqual(notified, [
    { slot: "voiceAgent", mode: "push" },
    { slot: "translation", mode: "tap" },
  ]);
});

test("startup sync adopts the main process's per-slot activation modes", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      voiceAgentActivationMode: "tap",
    },
    window: {
      electronAPI: {
        getActivationMode: async () => "tap",
        getSlotActivationModes: async () => ({ voiceAgent: "push", translation: "tap" }),
        setDictionary: async () => {},
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-slot-activation-modes-sync-test-",
    mockModules: {
      "/utils/agentName": "export const ensureAgentNameInDictionary = () => {};",
    },
  });
  const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );

  await initializeSettings();

  assert.equal(useSettingsStore.getState().voiceAgentActivationMode, "push");
  assert.equal(storage.getItem("voiceAgentActivationMode"), "push");
});
