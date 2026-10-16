const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function startSettings(t, storageListeners) {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      "customPrompt.dictationAgent": "Always use British spelling.",
      emailDraftTarget: "gmail",
      // Already holds the agent name, so startup writes no dictionary and
      // starts no cloud sync that would outlive the test's module server.
      customDictionary: '["OpenWhispr"]',
    },
    window: {
      addEventListener(type, listener) {
        if (type === "storage") storageListeners.push(listener);
      },
      electronAPI: {
        getOpenAIKey: async () => "",
        setDictionary: async () => {},
        mcalGetConnectionStatus: async () => ({ connected: false, accounts: [] }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-custom-prompt-sync-test-",
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

test("a prompt another window removed counts as unsaved here", async (t) => {
  const storageListeners = [];
  const { storage, useSettingsStore } = await startSettings(t, storageListeners);
  const sync = (key) => {
    storage.removeItem(key);
    storageListeners.forEach((listener) => listener({ key, newValue: null, storageArea: storage }));
  };
  assert.equal(
    useSettingsStore.getState().customPrompts.dictationAgent,
    "Always use British spelling."
  );

  // The retired-prompt sweep removes the key in whichever window gets there first.
  sync("customPrompt.dictationAgent");
  assert.equal(useSettingsStore.getState().customPrompts.dictationAgent, "");

  // Other settings still ignore a removal.
  sync("emailDraftTarget");
  assert.equal(useSettingsStore.getState().emailDraftTarget, "gmail");
});
