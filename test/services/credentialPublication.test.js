const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { createFakeSecretApi } = require("../lib/fakeSecretApi");

// Separate Vite module graphs represent independent renderer JS/store/service owners.
test("two renderer owners see rotations/clears without TTL caching or immediate-save refill races", async (t) => {
  const owners = [], logs = [];
  t.after(() => {
    for (const owner of owners) owner.service.destroy();
    delete globalThis.__credentialLogs;
  });
  globalThis.__credentialLogs = logs;
  const values = new Map([
    ["openaiApiKey", "fake-old"],
    ["anthropicApiKey", "fake-independent"],
    ["tinfoilApiKey", "fake-tinfoil-old"],
  ]);
  const { api, saves } = createFakeSecretApi({ values });
  installBrowserGlobals(t, {
    initialStorage: { _dictationAgentSeeded: "1" },
    window: { electronAPI: api, dispatchEvent() {} },
  });
  for (let index = 0; index < 2; index++) {
    const vite = await createRendererServer(t, {
      noExternal: ["tinfoil"],
      mockModules: {
        "/i18n": `export const normalizeUiLanguage = value => value || "en"; export default {language: "en", changeLanguage: async () => {}};`,
        "/utils/agentName": `export const ensureAgentNameInDictionary = () => {};`,
        "/models/tinfoilModels": `export const refreshTinfoilModels = async () => {};`,
        // The suffix-based harness must distinguish the provider from the SDK package.
        "./tinfoil": `export { tinfoilProvider } from "/services/ai/inferenceProviders/tinfoil.ts";`,
        tinfoil: `
          export class TinfoilAI { constructor({ apiKey }) { this.apiKey = apiKey; } }
          export const createTinfoilAI = async apiKey => {
            const model = { apiKey };
            return () => model;
          };
        `,
        "/utils/logger": `const log = (...args) => globalThis.__credentialLogs?.push(args); export default {warn: log, debug: log, error: log, info: log, logReasoning: log};`,
      },
    });
    const { useSettingsStore: store, initializeSettings } = await vite.ssrLoadModule(
      "/stores/settingsStore.ts"
    );
    await initializeSettings();
    const { default: service } = await vite.ssrLoadModule("/services/ReasoningService.ts");
    const clients = await vite.ssrLoadModule("/services/ai/tinfoilClient.ts");
    owners.push({ store, service, clients });
  }
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) =>
    timeout(delay === 1000 ? () => {} : fn, delay === 1000 ? 0 : delay, ...args)
  );
  const [one, two] = owners;
  const chat = await one.clients.getTinfoilChatClient("fake-tinfoil-old");
  const model = await two.clients.getTinfoilLanguageModel("fake-tinfoil-old", "test-model");
  assert.equal(await one.clients.getTinfoilChatClient("fake-tinfoil-old"), chat);
  assert.equal(await two.clients.getTinfoilLanguageModel("fake-tinfoil-old", "test-model"), model);
  assert.equal(await one.service.getApiKey("openai"), "fake-old");
  assert.equal(await two.service.getApiKey("openai"), "fake-old");
  one.store.getState().setOpenaiApiKey("fake-rotate");
  let settled = false;
  const immediate = one.service.getApiKey("openai").then((key) => {
    settled = true;
    return key;
  });
  await Promise.resolve();
  assert.equal(settled, false, "immediate inference waits for its dedicated publication request");
  assert.equal(
    await two.service.getApiKey("openai"),
    "fake-rotate",
    "other renderer never keeps a one-hour cache"
  );
  saves.at(-1).resolve({ success: true });
  assert.equal(await immediate, "fake-rotate");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(two.store.getState().openaiApiKey, "fake-rotate");
  assert.equal(two.store.getState().anthropicApiKey, "fake-independent");
  assert.equal(await one.clients.getTinfoilChatClient("fake-tinfoil-old"), chat);
  assert.equal(
    await two.clients.getTinfoilLanguageModel("fake-tinfoil-old", "test-model"),
    model,
    "ordinary credential metadata is not a clear-all request"
  );

  one.store.getState().setTinfoilApiKey("fake-tinfoil-new");
  saves.at(-1).resolve({ success: true });
  await new Promise(setImmediate);
  assert.equal(await one.service.getApiKey("tinfoil"), "fake-tinfoil-new");
  assert.equal(two.store.getState().tinfoilApiKey, "fake-tinfoil-new");
  assert.notEqual(await one.clients.getTinfoilChatClient("fake-tinfoil-old"), chat);
  assert.notEqual(
    await two.clients.getTinfoilLanguageModel("fake-tinfoil-old", "test-model"),
    model,
    "Tinfoil metadata evicts the other renderer's SDK provider"
  );
  const currentChat = await one.clients.getTinfoilChatClient("fake-tinfoil-new");
  const currentModel = await one.clients.getTinfoilLanguageModel("fake-tinfoil-new", "test-model");
  one.service.clearApiKeyCache();
  assert.notEqual(await one.clients.getTinfoilChatClient("fake-tinfoil-new"), currentChat);
  assert.notEqual(
    await one.clients.getTinfoilLanguageModel("fake-tinfoil-new", "test-model"),
    currentModel,
    "explicit clear-all still evicts both real Tinfoil caches"
  );

  one.store.getState().setOpenaiApiKey("fake-overlap-old");
  const olderSave = saves.at(-1);
  one.store.getState().setOpenaiApiKey("fake-overlap-new");
  const newestSave = saves.at(-1);
  const latest = one.service.getApiKey("openai");
  newestSave.resolve({ success: true });
  olderSave.resolve({ success: false, code: "SECRET_PERSIST_FAILED" });
  assert.equal(await latest, "fake-overlap-new");
  assert.equal(await two.service.getApiKey("openai"), "fake-overlap-new");

  const publishOpenai = api.saveOpenAIKey;
  api.saveOpenAIKey = async () => {
    throw new Error("fake IPC publication failure");
  };
  one.store.getState().setOpenaiApiKey("fake-not-published");
  await assert.rejects(one.service.getApiKey("openai"), { code: "SECRET_PUBLICATION_FAILED" });
  assert.equal(await two.service.getApiKey("openai"), "fake-overlap-new");
  api.saveOpenAIKey = publishOpenai;
  let recoveryReads = 0;
  const getOpenai = api.getOpenAIKey;
  api.getOpenAIKey = async () => {
    recoveryReads++;
    return getOpenai();
  };
  two.store.getState().setOpenaiApiKey("fake-recovered");
  saves.at(-1).resolve({ success: true });
  await new Promise(setImmediate);
  assert.equal(recoveryReads, 2, "metadata reaches both authoritative getters after A's failure");
  assert.equal(one.store.getState().openaiApiKey, "fake-recovered");
  assert.equal(await one.service.getApiKey("openai"), "fake-recovered");

  one.store.getState().setNoteFormattingCustomApiKey("fake-scope");
  saves.at(-1).resolve({ success: true });
  await new Promise(setImmediate);
  assert.equal(two.store.getState().noteFormattingCustomApiKey, "fake-scope");
  assert.equal(
    two.store.getState().cleanupCustomApiKey,
    "",
    "scope overrides do not replace the shared key"
  );
  one.store.getState().setOpenaiApiKey("");
  saves.at(-1).resolve({ success: true });
  await assert.rejects(one.service.getApiKey("openai"), { code: "API_KEY_MISSING" });
  await assert.rejects(two.service.getApiKey("openai"), { code: "API_KEY_MISSING" });
  assert.equal(await two.service.getApiKey("anthropic"), "fake-independent");
  assert.equal(localStorage.getItem("openaiApiKey"), null);
  assert.equal(JSON.stringify(logs).includes("fake-rotate"), false);
  assert.equal(JSON.stringify(logs).includes("fake-overlap-new"), false);
});
