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

// Two windows start on the same cached list against a database that has never
// held one. One window's seed lands; main refuses the other's, which must take
// what SQLite now holds rather than the empty list it read before seeding.
test("a window whose first seed loses the race takes the list the other window stored", async (t) => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  let stored = [];
  let everSeeded = false;
  const seeds = [];
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { customDictionary: '["Kubernetes", "kubernetes"]' },
    window: {
      electronAPI: {
        getOpenAIKey: async () => "",
        getDictionary: async () => {
          await tick();
          return [...stored];
        },
        seedDictionary: async (words) => {
          await tick();
          if (everSeeded) {
            seeds.push("refused");
            return { success: true, seeded: false };
          }
          everSeeded = true;
          // SQLite dedupes by lower case and keeps the first spelling.
          stored = words.filter(
            (word, index) =>
              words.findIndex((other) => other.toLowerCase() === word.toLowerCase()) === index
          );
          seeds.push("seeded");
          return { success: true, seeded: true };
        },
        applyDictionaryChanges: () => new Promise(() => {}),
        getSnippets: async () => [],
      },
    },
  });
  const loadWindow = async (name) => {
    const vite = await createRendererServer(t, {
      cachePrefix: `openwhispr-settings-seed-race-${name}-`,
    });
    return {
      vite,
      store: await vite.ssrLoadModule("/stores/settingsStore.ts"),
    };
  };
  const controlPanel = await loadWindow("control-panel");
  const dictation = await loadWindow("dictation");
  try {
    await Promise.all([
      controlPanel.store.initializeSettings(),
      dictation.store.initializeSettings(),
    ]);
  } finally {
    for (const window of [controlPanel, dictation]) {
      const { default: i18n } = await window.vite.ssrLoadModule("/i18n.ts");
      await i18n.changeLanguage("en");
    }
  }

  assert.deepEqual(seeds, ["seeded", "refused"]);
  assert.deepEqual(stored, ["Kubernetes"]);
  // Startup then adds the agent name optimistically; its write never settles here.
  const withoutAgentName = (words) => words.filter((word) => word !== "OpenWhispr");
  for (const window of [controlPanel, dictation]) {
    assert.deepEqual(
      withoutAgentName(window.store.useSettingsStore.getState().customDictionary),
      ["Kubernetes"],
      "each window shows what SQLite stored, the refused one included"
    );
  }
  assert.deepEqual(withoutAgentName(JSON.parse(storage.getItem("customDictionary"))), [
    "Kubernetes",
  ]);
});

// A window that starts between a token rotation and the re-scope reads the
// credential binding as signed out while main's database still scopes rows to
// the same account. Its lists belong to that account, so its whole-list saves
// name it, and the same-account re-scope changes nothing.
async function loadSettingsWindow(t, { electronAPI, cachePrefix, initialStorage }) {
  const globals = installBrowserGlobals(t, {
    initialStorage,
    window: {
      electronAPI: {
        getOpenAIKey: async () => "",
        // Startup adds the agent name; never settling keeps that write from
        // starting a cloud sync that would outlive the test's module server.
        applyDictionaryChanges: () => new Promise(() => {}),
        ...electronAPI,
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix });
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  try {
    await store.initializeSettings();
  } finally {
    const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
    await i18n.changeLanguage("en");
  }
  // The scope read runs after startup's own reads.
  await new Promise((resolve) => setImmediate(resolve));
  return { ...globals, store };
}

test("a window started between a token rotation and the re-scope saves its lists as that account's", async (t) => {
  const saves = [];
  let onDatabaseScope;
  const { store } = await loadSettingsWindow(t, {
    cachePrefix: "openwhispr-settings-scope-gap-",
    electronAPI: {
      getActiveAccountScope: async () => null,
      getDatabaseAccountScope: async () => ({
        accountId: "account-a",
        visibleAccountId: "account-a",
      }),
      onDatabaseAccountScopeChanged: (callback) => {
        onDatabaseScope = callback;
        return () => {};
      },
      getDictionary: async () => ["Kubernetes"],
      getSnippets: async () => [{ trigger: "addr", replacement: "A's address" }],
      // Main accepts a save named for its account; never settling keeps the
      // sync that follows from outliving the test's module server.
      setSnippets: (snippets, listsAccountId) => {
        saves.push(listsAccountId);
        return new Promise(() => {});
      },
    },
  });
  const sig = { trigger: "sig", replacement: "Best, A" };

  store.useSettingsStore
    .getState()
    .setSnippets([{ trigger: "addr", replacement: "A's address" }, sig]);
  onDatabaseScope({ accountId: "account-a", visibleAccountId: "account-a" });
  store.useSettingsStore.getState().setSnippets([sig]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(saves, ["account-a", "account-a"]);
  assert.deepEqual(store.useSettingsStore.getState().snippets, [sig]);
});

test("a whole-list save main refuses as another account's takes what SQLite holds", async (t) => {
  const stored = {
    dictionary: ["Kubernetes"],
    snippets: [{ trigger: "addr", replacement: "B's address" }],
  };
  const { store, storage } = await loadSettingsWindow(t, {
    cachePrefix: "openwhispr-settings-refused-save-",
    electronAPI: {
      getDatabaseAccountScope: async () => ({
        accountId: "account-b",
        visibleAccountId: "account-b",
      }),
      getDictionary: async () => [...stored.dictionary],
      getSnippets: async () => [...stored.snippets],
      setDictionary: async () => ({ success: false, stale: true }),
      setSnippets: async () => ({ success: false, stale: true }),
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  store.useSettingsStore.getState().setCustomDictionary(["A's word"]);
  store.useSettingsStore.getState().setSnippets([{ trigger: "addr", replacement: "A's address" }]);
  await settle();
  await settle();

  const state = store.useSettingsStore.getState();
  assert.deepEqual(state.customDictionary, stored.dictionary);
  assert.deepEqual(state.snippets, stored.snippets);
  assert.deepEqual(JSON.parse(storage.getItem("customDictionary")), stored.dictionary);
  assert.deepEqual(JSON.parse(storage.getItem("snippets")), stored.snippets);
});
