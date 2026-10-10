const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { createFakeSecretApi } = require("../lib/fakeSecretApi");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const timeoutMockTrackers = new WeakSet();

async function load(t, api, initialStorage = {}) {
  installBrowserGlobals(t, {
    initialStorage: { _dictationAgentSeeded: "1", ...initialStorage },
    window: { electronAPI: api, dispatchEvent() {} },
  });
  const vite = await createRendererServer(t, {
    mockModules: {
      "/i18n": `export const normalizeUiLanguage = value => value || "en"; export default {language: "en", changeLanguage: async () => {}};`,
      "/utils/agentName": `export const ensureAgentNameInDictionary = () => {};`,
      "/utils/logger": `export default {warn() {}, debug() {}, error() {}, info() {}};`,
      "/services/ReasoningService": `export default {clearApiKeyCache() {}};`,
    },
  });
  const mod = await vite.ssrLoadModule("/stores/settingsStore.ts");
  if (!timeoutMockTrackers.has(t.mock)) {
    timeoutMockTrackers.add(t.mock);
    const timeout = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) =>
      timeout(delay === 1000 ? () => {} : fn, delay === 1000 ? 0 : delay, ...args)
    );
  }
  return mod;
}

test("startup hydration and awaited migration never overwrite newer edits/clears or independent fields", async (t) => {
  const read = deferred(),
    migration = deferred();
  const writes = [];
  let notifications = 0,
    reads = 0;
  const { api } = createFakeSecretApi({
    onSave: (field, key) => {
      writes.push({ field, key });
      return { success: true };
    },
  });
  Object.assign(api, {
    syncNotificationPreferences: async () => notifications++,
    getOpenAIKey: () => {
      reads++;
      return read.promise;
    },
    getAnthropicKey: async () => "fake-independent",
    getGeminiKey: async () => "fake-old-gemini",
    getAzureApiKey: async () => "fake-old-azure",
    saveAzureApiKey: async (key) => {
      writes.push({ field: "azureApiKey", key });
      return { success: true };
    },
    saveNoteFormattingCustomKey: (key) => {
      writes.push({ field: "noteFormattingCustomApiKey", key });
      return key === "fake-legacy" ? migration.promise : Promise.resolve({ success: true });
    },
  });
  const { useSettingsStore: store, initializeSettings } = await load(t, api, {
    noteFormattingCustomApiKey: "fake-legacy",
  });
  const init = initializeSettings();
  await Promise.resolve();
  assert.equal(notifications, 1, "startup preferences precede key reads");
  store.getState().setOpenaiApiKey("fake-new-openai");
  store.getState().setGeminiApiKey("");
  store.getState().setAzureApiKey("fake-new-azure");
  read.resolve("fake-old-openai");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(
    writes.some((w) => w.key === "fake-legacy"),
    "migration is actually pending"
  );
  store.getState().setNoteFormattingCustomApiKey("fake-new-scope");
  migration.resolve({ success: true });
  await init;
  assert.equal(store.getState().openaiApiKey, "fake-new-openai");
  assert.equal(store.getState().geminiApiKey, "");
  assert.equal(store.getState().azureApiKey, "fake-new-azure");
  assert.equal(store.getState().noteFormattingCustomApiKey, "fake-new-scope");
  assert.equal(store.getState().anthropicApiKey, "fake-independent");
  assert.ok(writes.some((w) => w.field === "geminiApiKey" && w.key === ""));
  assert.ok(
    writes.some((w) => w.field === "noteFormattingCustomApiKey" && w.key === "fake-new-scope")
  );
  await initializeSettings();
  assert.equal(reads, 1, "startup replay does not repeat reads or migration writes");

  // A rejected getter cannot clobber an edit made during hydration; rides its own store instance.
  const failedRead = deferred();
  const { useSettingsStore: failedStore, initializeSettings: failedInitializeSettings } =
    await load(t, {
      getOpenAIKey: () => failedRead.promise,
      saveOpenAIKey: async () => ({ success: true }),
    });
  const failedInit = failedInitializeSettings();
  await Promise.resolve();
  failedStore.getState().setOpenaiApiKey("fake-new");
  failedRead.reject(new Error("fake getter failure"));
  await failedInit;
  assert.equal(failedStore.getState().openaiApiKey, "fake-new");
});

test("failed secure migration keeps the legacy copy recoverable", async (t) => {
  const api = {
    getOpenAIKey: async () => "fake-openai",
    getNoteFormattingCustomKey: async () => "",
    saveNoteFormattingCustomKey: async () => ({ success: false }),
  };
  const { useSettingsStore: store, initializeSettings } = await load(t, api, {
    noteFormattingCustomApiKey: "fake-recoverable",
    openaiApiKey: "fake-stale-plaintext",
  });
  await initializeSettings();
  assert.equal(localStorage.getItem("noteFormattingCustomApiKey"), "fake-recoverable");
  assert.equal(store.getState().openaiApiKey, "fake-openai", "other secrets still hydrate");
  assert.equal(localStorage.getItem("openaiApiKey"), null, "migrated stale copies are swept");
});

test("metadata refresh accepts only current field/version/read ownership and never persists secrets in localStorage", async (t) => {
  let listener;
  const api = {
    onSecretKeyChanged: (callback) => {
      listener = callback;
      return () => {};
    },
    getOpenAIKey: async () => "fake-initial",
    saveOpenAIKey: async () => ({ success: true }),
  };
  const { useSettingsStore: store, initializeSettings } = await load(t, api);
  await initializeSettings();
  const reads = [];
  api.getOpenAIKey = () => new Promise((resolve) => reads.push(resolve));
  listener({ key: "openaiApiKey", version: 1 });
  await Promise.resolve();
  await Promise.resolve();
  listener({ key: "openaiApiKey", version: 2 });
  await Promise.resolve();
  await Promise.resolve();
  reads[1]("fake-newer");
  await Promise.resolve();
  await Promise.resolve();
  reads[0]("fake-obsolete");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getState().openaiApiKey, "fake-newer");
  listener({ key: "openaiApiKey", version: 3 });
  await Promise.resolve();
  await Promise.resolve();
  store.getState().setOpenaiApiKey("");
  reads[2]("fake-before-clear");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getState().openaiApiKey, "");
  listener({ key: "unknown", version: 4 });
  listener({ key: "openaiApiKey", version: 1 });
  assert.equal(reads.length, 3);
  assert.equal(localStorage.getItem("openaiApiKey"), null);
});
