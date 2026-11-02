const test = require("node:test");
const assert = require("node:assert/strict");
const { BYOK_API_KEYS } = require("../../src/config/secretKeys");
const { deferred } = require("./harness/deferred");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

const bindings = [
  ...BYOK_API_KEYS,
  ...[
    ["customTranscriptionApiKey", "getCustomTranscriptionKey"],
    ["cleanupCustomApiKey", "getCleanupCustomKey"],
    ["cortiClientId", "getCortiClientId"],
    ["cortiClientSecret", "getCortiClientSecret"],
    ["bedrockAccessKeyId", "getBedrockAccessKeyId"],
    ["bedrockSecretAccessKey", "getBedrockSecretAccessKey"],
    ["bedrockSessionToken", "getBedrockSessionToken"],
    ["azureApiKey", "getAzureApiKey"],
    ["vertexApiKey", "getVertexApiKey"],
  ].map(([storeKey, get]) => ({ storeKey, get })),
];

async function loadSettings(t, overrides = {}) {
  const keys = new Map(bindings.map(({ storeKey }) => [storeKey, `old-${storeKey}`]));
  const events = new EventTarget();
  let update;
  const api = Object.fromEntries(
    bindings.map(({ storeKey, get }) => [get, async () => keys.get(storeKey)])
  );
  const { window, storage } = installBrowserGlobals(t, {
    initialStorage: { _dictationAgentSeeded: "1", customDictionary: '["OpenWhispr"]' },
    window: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      cacheClears: [],
      warnings: [],
      electronAPI: {
        ...api,
        setDictionary: async () => {},
        onApiKeyUpdated: (callback) => {
          update = callback;
        },
        ...overrides,
      },
    },
  });
  installMicCaptureGlobals(t);
  const vite = await createRendererServer(t, {
    mockModules: {
      "/services/ReasoningService":
        "export default { clearApiKeyCache: (...args) => window.cacheClears.push(args) };",
      "/utils/logger": `export default {
        debug() {}, info() {}, error() {}, logReasoning() {},
        warn: (...args) => window.warnings.push(args)
      };`,
    },
  });
  await vite.ssrLoadModule("/services/ReasoningService");
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  return { ...settings, keys, storage, window, vite, update: (key) => update(key) };
}

test("all registered secrets refresh in memory without persistence or save loops", async (t) => {
  const context = await loadSettings(t);
  await context.initializeSettings();
  const changes = [];
  let saves = 0;
  let persists = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  context.window.addEventListener("api-key-changed", () => changes.push(true));
  context.window.electronAPI.saveAllKeysToEnv = async () => {
    persists += 1;
  };
  for (const { storeKey, get } of bindings) {
    context.window.electronAPI[get.replace(/^get/, "save")] = async () => {
      saves += 1;
    };
    for (const value of [`new-${storeKey}`, ""]) {
      context.keys.set(storeKey, value);
      await context.update(storeKey);
      assert.equal(context.useSettingsStore.getState()[storeKey], value, storeKey);
      assert.equal(context.storage.getItem(storeKey), null, storeKey);
    }
  }
  t.mock.timers.tick(1000);
  assert.equal(saves, 0);
  assert.equal(persists, 0);
  assert.equal(changes.length, bindings.length * 2);
  await context.vite.ssrLoadModule("/services/ReasoningService");
  assert.equal(context.window.cacheClears.length, bindings.length * 2);
  assert.ok(context.window.cacheClears.every(([provider]) => provider === undefined));
});

test("the next batch dictation reads the changed key, not its populated cache", async (t) => {
  const context = await loadSettings(t);
  await context.initializeSettings();
  const { default: AudioManager } = await context.vite.ssrLoadModule("/helpers/audioManager.js");
  const manager = new AudioManager();
  try {
    for (const [provider, storeKey] of [
      ["openai", "openaiApiKey"],
      ["groq", "groqApiKey"],
      ["custom", "customTranscriptionApiKey"],
    ]) {
      context.useSettingsStore.setState({
        useLocalWhisper: false,
        transcriptionMode: "providers",
        cloudTranscriptionMode: "byok",
        cloudTranscriptionProvider: provider,
      });
      assert.equal(await manager.getAPIKey(), `old-${storeKey}`);
      context.keys.set(storeKey, `new-${storeKey}`);
      await context.update(storeKey);
      assert.equal(await manager.getAPIKey(), `new-${storeKey}`);
      context.keys.set(storeKey, "");
      await context.update(storeKey);
      if (provider === "custom") assert.equal(await manager.getAPIKey(), null);
      else await assert.rejects(() => manager.getAPIKey(), { code: "API_KEY_MISSING" });
    }
  } finally {
    manager.cleanup();
  }
});

test("a changed key re-warms streaming dictation without opening the mic", async (t) => {
  const warmups = [];
  const context = await loadSettings(t, {
    deepgramStreamingWarmup: async (options) => {
      warmups.push(options);
      return { success: true };
    },
  });
  await context.initializeSettings();
  const { default: AudioManager } = await context.vite.ssrLoadModule("/helpers/audioManager.js");
  const manager = new AudioManager();
  const runs = [];
  const warmup = manager.warmupStreamingConnection.bind(manager);
  manager.warmupStreamingConnection = (options) => {
    runs.push(warmup(options));
    return runs.at(-1);
  };
  let micOpens = 0;
  const { getUserMedia } = navigator.mediaDevices;
  navigator.mediaDevices.getUserMedia = (...args) => {
    micOpens += 1;
    return getUserMedia(...args);
  };
  try {
    context.useSettingsStore.setState({
      useLocalWhisper: false,
      transcriptionMode: "providers",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "deepgram",
    });
    context.keys.set("deepgramApiKey", "new-deepgramApiKey");
    await context.update("deepgramApiKey");
    assert.equal(runs.length, 1);
    assert.equal(await runs[0], true);
    assert.equal(warmups[0].mode, "byok");
    assert.equal(micOpens, 0);

    // A dictation in progress keeps its connection; the post-dictation re-warm
    // picks the new key up.
    manager.isRecording = true;
    context.keys.set("deepgramApiKey", "newer-deepgramApiKey");
    await context.update("deepgramApiKey");
    assert.equal(runs.length, 1);
  } finally {
    manager.cleanup();
  }
});

for (const { name, value, failHydration } of [
  { name: "replacement", value: "new-custom" },
  { name: "removal", value: "" },
  { name: "failed hydration", value: "new-custom", failHydration: true },
]) {
  test(`startup ${name} survives hydration`, { timeout: 15_000 }, async (t) => {
    const started = deferred();
    const held = deferred();
    let reads = 0;
    const context = await loadSettings(t, {
      getCustomTranscriptionKey: async () => {
        if (++reads > 1) return value;
        started.resolve();
        await held.promise;
        if (failHydration) throw new Error("hydration failed");
        return "old-custom";
      },
    });
    const initialization = context.initializeSettings();
    await started.promise;
    await context.update("customTranscriptionApiKey");
    held.resolve();
    await initialization;
    assert.equal(context.useSettingsStore.getState().customTranscriptionApiKey, value);
    assert.equal(reads, 2);
    assert.equal(context.storage.getItem("customTranscriptionApiKey"), null);
  });
}

test("unknown settings cannot invoke getters, and refresh errors cannot log secrets", async (t) => {
  const context = await loadSettings(t);
  await context.initializeSettings();
  let forbiddenReads = 0;
  context.window.electronAPI.getDictationKey = async () => {
    forbiddenReads += 1;
    return "not-a-secret";
  };
  await context.update("dictationKey");
  assert.equal(forbiddenReads, 0);
  context.window.electronAPI.getCustomTranscriptionKey = async () => {
    throw new Error("secret-leak-marker");
  };
  await context.update("customTranscriptionApiKey");
  assert.ok(context.window.warnings.length > 0);
  assert.ok(!JSON.stringify(context.window.warnings).includes("secret-leak-marker"));
  assert.equal(
    context.useSettingsStore.getState().customTranscriptionApiKey,
    "old-customTranscriptionApiKey"
  );
});
