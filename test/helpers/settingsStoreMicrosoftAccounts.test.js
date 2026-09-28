const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const SAVED_ACCOUNTS = [{ email: "a@corp.com" }];

async function startSettings(t, { mcalGetConnectionStatus, storageListeners = [] }) {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      mcalAccounts: JSON.stringify(SAVED_ACCOUNTS),
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
        mcalGetConnectionStatus,
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-mcal-accounts-test-",
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

test("startup replaces the saved Microsoft accounts with main's, tenant ids included", async (t) => {
  const accounts = [
    { email: "a@corp.com", tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47" },
    { email: "me@outlook.com", tenantId: null },
  ];
  const { storage, useSettingsStore } = await startSettings(t, {
    mcalGetConnectionStatus: async () => ({ connected: true, accounts }),
  });
  assert.deepEqual(useSettingsStore.getState().mcalAccounts, accounts);
  assert.equal(useSettingsStore.getState().mcalConnected, true);
  assert.deepEqual(JSON.parse(storage.getItem("mcalAccounts")), accounts);
});

test("an empty answer leaves the saved Microsoft accounts alone", async (t) => {
  const { storage, useSettingsStore } = await startSettings(t, {
    mcalGetConnectionStatus: async () => ({ connected: false, accounts: [] }),
  });
  assert.deepEqual(useSettingsStore.getState().mcalAccounts, SAVED_ACCOUNTS);
  assert.deepEqual(JSON.parse(storage.getItem("mcalAccounts")), SAVED_ACCOUNTS);
});

test("a failed read leaves the saved Microsoft accounts alone", async (t) => {
  const { storage, useSettingsStore } = await startSettings(t, {
    mcalGetConnectionStatus: async () => {
      throw new Error("ipc down");
    },
  });
  assert.deepEqual(useSettingsStore.getState().mcalAccounts, SAVED_ACCOUNTS);
  assert.deepEqual(JSON.parse(storage.getItem("mcalAccounts")), SAVED_ACCOUNTS);
});

test("a draft target synced from another window is normalised", async (t) => {
  const storageListeners = [];
  const { storage, useSettingsStore } = await startSettings(t, {
    mcalGetConnectionStatus: async () => ({ connected: false, accounts: [] }),
    storageListeners,
  });
  const sync = (newValue) =>
    storageListeners.forEach((listener) =>
      listener({ key: "emailDraftTarget", newValue, storageArea: storage })
    );

  sync("gmail");
  assert.equal(useSettingsStore.getState().emailDraftTarget, "gmail");
  sync("yahoo");
  assert.equal(useSettingsStore.getState().emailDraftTarget, "auto");
});
