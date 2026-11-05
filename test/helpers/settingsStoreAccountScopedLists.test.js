const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A window's cached dictionary and snippets may be another account's. At
// startup main refuses to seed them into a database that already holds any
// account's lists, and the window then takes this account's lists instead.
test("startup drops a cached list main refuses to seed", async (t) => {
  const seeded = [];
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      customDictionary: '["Kubernetes"]',
      snippets: JSON.stringify([{ trigger: "addr", replacement: "another account's address" }]),
    },
    window: {
      electronAPI: {
        getOpenAIKey: async () => "",
        getDictionary: async () => [],
        seedDictionary: async (words) => {
          seeded.push(["dictionary", words]);
          return { success: true, seeded: false };
        },
        // Startup then adds the agent name. Never settling keeps that write from
        // starting a cloud sync that would outlive the test's module server.
        applyDictionaryChanges: () => new Promise(() => {}),
        getSnippets: async () => [],
        seedSnippets: async (snippets) => {
          seeded.push(["snippets", snippets]);
          return { success: true, seeded: false };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-account-lists-test-",
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

  assert.deepEqual(seeded, [
    ["dictionary", ["Kubernetes"]],
    ["snippets", [{ trigger: "addr", replacement: "another account's address" }]],
  ]);
  const { customDictionary, snippets } = useSettingsStore.getState();
  assert.equal(customDictionary.includes("Kubernetes"), false, "the cached word is dropped");
  assert.deepEqual(snippets, [], "so is the cached snippet");
  assert.equal(JSON.parse(storage.getItem("customDictionary")).includes("Kubernetes"), false);
  assert.deepEqual(JSON.parse(storage.getItem("snippets")), []);
});
