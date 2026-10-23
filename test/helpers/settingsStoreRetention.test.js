const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function startSettings(t, { initialStorage = {}, storageListeners = [] } = {}) {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      // Already holds the agent name, so startup writes no dictionary and
      // starts no cloud sync that would outlive the test's module server.
      customDictionary: '["OpenWhispr"]',
      ...initialStorage,
    },
    window: {
      addEventListener(type, listener) {
        if (type === "storage") storageListeners.push(listener);
      },
      electronAPI: { getOpenAIKey: async () => "", setDictionary: async () => {} },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-retention-test-",
  });
  const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  try {
    await initializeSettings();
  } finally {
    const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
    await i18n.changeLanguage("en");
  }
  return { storage, useSettingsStore };
}

test("chat and meeting transcript retention default to keeping everything", async (t) => {
  const { useSettingsStore } = await startSettings(t);
  const { chatRetentionDays, meetingTranscriptRetentionDays } = useSettingsStore.getState();

  assert.equal(chatRetentionDays, 0);
  assert.equal(meetingTranscriptRetentionDays, 0);
});

test("an existing profile keeps its periods and keeps every chat and transcript", async (t) => {
  const { useSettingsStore } = await startSettings(t, {
    initialStorage: { audioRetentionDays: "7", transcriptRetentionDays: "30" },
  });
  const state = useSettingsStore.getState();

  assert.deepEqual(
    [
      state.audioRetentionDays,
      state.transcriptRetentionDays,
      state.chatRetentionDays,
      state.meetingTranscriptRetentionDays,
    ],
    [7, 30, 0, 0]
  );
});

test("a retention period chosen in another window arrives as a number", async (t) => {
  const storageListeners = [];
  const { storage, useSettingsStore } = await startSettings(t, { storageListeners });

  for (const key of ["chatRetentionDays", "meetingTranscriptRetentionDays"]) {
    for (const listener of storageListeners) {
      listener({ key, newValue: "30", storageArea: storage });
    }
    assert.equal(useSettingsStore.getState()[key], 30, key);
  }
});
