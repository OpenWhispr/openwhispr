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

test("a shell update during a debounced edit reconciles after save and clears pre-save caches", async (t) => {
  const context = await loadSettings(t);
  await context.initializeSettings();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { electronAPI } = context.window;
  const saved = deferred();
  electronAPI.saveOpenAIKey = async (key) => {
    await saved.promise;
    context.keys.set("openaiApiKey", key);
  };
  const state = () => context.useSettingsStore.getState();
  state().setOpenaiApiKey("$GROQ_API_KEY");
  context.keys.set("openaiApiKey", "$OPENAI_API_KEY");
  await context.update("openaiApiKey");
  assert.equal(state().openaiApiKey, "$GROQ_API_KEY");
  t.mock.timers.tick(250);
  await context.update("openaiApiKey");
  assert.equal(state().openaiApiKey, "$GROQ_API_KEY");
  await new Promise(setImmediate);
  const clearsBeforeSave = context.window.cacheClears.length;
  saved.resolve();
  await new Promise(setImmediate);
  assert.ok(context.window.cacheClears.length > clearsBeforeSave);
  assert.equal(state().openaiApiKey, "$GROQ_API_KEY");
  assert.equal(context.keys.get("openaiApiKey"), "$GROQ_API_KEY");
});

test("a delayed dictation read cannot refill the cache after a referenced enterprise key changes", async (t) => {
  const held = deferred();
  let target = "first-target";
  let first = true;
  const context = await loadSettings(t, {
    resolveSecretRef: async () => {
      if (first) {
        first = false;
        return held.promise;
      }
      return target;
    },
    saveVertexApiKey: async (key) => {
      target = key;
    },
  });
  await context.initializeSettings();
  context.useSettingsStore.setState({
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    customTranscriptionApiKey: "$VERTEX_API_KEY",
  });
  const { default: AudioManager } = await context.vite.ssrLoadModule("/helpers/audioManager.js");
  const manager = new AudioManager();
  try {
    const firstRequest = manager.getAPIKey();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    context.useSettingsStore.getState().setVertexApiKey("second-target");
    t.mock.timers.tick(250);
    await new Promise(setImmediate);
    held.resolve("first-target");
    await firstRequest;
    assert.equal(await manager.getAPIKey(), "second-target");
    assert.equal(context.window.cacheClears.length, 0);
  } finally {
    manager.cleanup();
  }
});

test("a local edit supersedes hydration and an earlier in-flight getter", async (t) => {
  const startup = deferred();
  const reading = deferred();
  const context = await loadSettings(t, {
    getOpenAIKey: async () => {
      reading.resolve();
      return startup.promise;
    },
  });
  const initialization = context.initializeSettings();
  await reading.promise;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = () => context.useSettingsStore.getState();
  state().setOpenaiApiKey("edited-during-startup");
  startup.resolve("old-startup-key");
  await initialization;
  assert.equal(state().openaiApiKey, "edited-during-startup");
  t.mock.timers.tick(250);
  await new Promise(setImmediate);

  const pending = deferred();
  context.window.electronAPI.getOpenAIKey = () => pending.promise;
  const refresh = context.update("openaiApiKey");
  state().setOpenaiApiKey("$GROQ_API_KEY");
  t.mock.timers.tick(250);
  await new Promise(setImmediate);
  pending.resolve("$OPENAI_API_KEY");
  await refresh;
  assert.equal(state().openaiApiKey, "$GROQ_API_KEY");
});

test("a blocked plaintext migration preserves its source until the user replaces or clears it", async (t) => {
  const context = await loadSettings(t, {
    getTranslationCustomKey: async () => "",
    getChatAgentCustomKey: async () => "",
    saveTranslationCustomKey: async (_key, migration) =>
      migration ? { success: false, reason: "storage-unavailable" } : { success: true },
    saveChatAgentCustomKey: async () => ({ success: true }),
  });
  context.storage.setItem("translationCustomApiKey", "upgrade-translation");
  context.storage.setItem("chatAgentCustomApiKey", "upgrade-chat");
  await context.initializeSettings();
  assert.equal(context.storage.getItem("translationCustomApiKey"), "upgrade-translation");
  assert.equal(context.storage.getItem("chatAgentCustomApiKey"), null);
  assert.equal(context.useSettingsStore.getState().chatAgentCustomApiKey, "upgrade-chat");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  context.useSettingsStore.getState().setTranslationCustomApiKey("");
  t.mock.timers.tick(250);
  await new Promise(setImmediate);
  assert.equal(context.storage.getItem("translationCustomApiKey"), null);
});

test("Voice Assistant waits for the old Chat credential to migrate before completing its setup", async (t) => {
  const context = await loadSettings(t, {
    getChatAgentCustomKey: async () => "",
    getDictationAgentCustomKey: async () => "",
    saveChatAgentCustomKey: async () => ({ success: false, reason: "storage-unavailable" }),
  });
  context.storage.setItem("_dictationAgentSeeded", "key-pending");
  context.storage.setItem("chatAgentCustomApiKey", "old-chat");
  await context.initializeSettings();
  assert.equal(context.storage.getItem("chatAgentCustomApiKey"), "old-chat");
  assert.equal(context.storage.getItem("_dictationAgentSeeded"), "key-pending");
  assert.equal(context.useSettingsStore.getState().dictationAgentCustomApiKey, "");
});

test("scope hydration distinguishes a stored reference from a shell alias with the same text", async (t) => {
  const migrates = [];
  const context = await loadSettings(t, {
    getTranslationCustomKey: async () => "$GROQ_API_KEY",
    getChatAgentCustomKey: async () => "$GROQ_API_KEY",
    saveTranslationCustomKey: async (...args) => {
      migrates.push(args);
      return { success: true };
    },
    saveChatAgentCustomKey: async (...args) => {
      migrates.push(args);
      return { success: true, retained: "$GROQ_API_KEY" };
    },
  });
  context.storage.setItem("translationCustomApiKey", "legacy-translation");
  context.storage.setItem("chatAgentCustomApiKey", "stale-chat");
  await context.initializeSettings();
  assert.deepEqual(migrates, [
    ["legacy-translation", true],
    ["stale-chat", true],
  ]);
  const state = context.useSettingsStore.getState();
  assert.equal(state.translationCustomApiKey, "legacy-translation");
  assert.equal(state.chatAgentCustomApiKey, "$GROQ_API_KEY");
  assert.equal(context.storage.getItem("translationCustomApiKey"), null);
  assert.equal(context.storage.getItem("chatAgentCustomApiKey"), null);
});

for (const change of [
  "sources replaced",
  "sources cleared",
  "destinations replaced",
  "destinations cleared",
  "occupied destinations",
  "previous migration",
  "main retained an edit",
]) {
  test(`startup credential seeding respects ${change}`, async (t) => {
    const started = deferred();
    const release = deferred();
    const values = new Map([
      ["openrouterApiKey", change === "occupied destinations" ? "router-existing" : ""],
      ["dictationAgentCustomApiKey", change === "occupied destinations" ? "agent-existing" : ""],
      ["cleanupCustomApiKey", "old-cleanup"],
      ["chatAgentCustomApiKey", "old-chat"],
    ]);
    const saves = [];
    const writer = (key) => async (value, migration) => {
      saves.push([key, value, migration]);
      if (change === "main retained an edit" && migration) {
        const retained = key === "openrouterApiKey" ? "" : "retained-agent";
        values.set(key, retained);
        return { success: true, retained };
      }
      values.set(key, value);
      return { success: true };
    };
    const context = await loadSettings(t, {
      getOpenAIKey: async () => {
        started.resolve();
        return release.promise;
      },
      getOpenrouterKey: async () => values.get("openrouterApiKey"),
      getDictationAgentCustomKey: async () => values.get("dictationAgentCustomApiKey"),
      getCleanupCustomKey: async () => values.get("cleanupCustomApiKey"),
      getChatAgentCustomKey: async () => values.get("chatAgentCustomApiKey"),
      saveOpenrouterKey: writer("openrouterApiKey"),
      saveDictationAgentCustomKey: writer("dictationAgentCustomApiKey"),
    });
    if (change === "previous migration") {
      context.storage.setItem("_openrouterCustomKeySeeded", "1");
    } else {
      context.storage.setItem("_dictationAgentSeeded", "key-pending");
    }
    context.useSettingsStore.setState({
      enterpriseSetupMode: "manual",
      cleanupMode: "providers",
      cleanupProvider: "custom",
      cleanupCloudBaseUrl: "https://openrouter.ai/api/v1",
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const initialization = context.initializeSettings();
    await started.promise;
    const state = () => context.useSettingsStore.getState();
    if (change.startsWith("sources")) {
      values.set("cleanupCustomApiKey", change === "sources replaced" ? "peer-cleanup" : "");
      values.set("chatAgentCustomApiKey", change === "sources replaced" ? "peer-chat" : "");
      await context.update("cleanupCustomApiKey");
      await context.update("chatAgentCustomApiKey");
    } else if (change.startsWith("destinations")) {
      values.set("openrouterApiKey", change === "destinations replaced" ? "peer-router" : "");
      await context.update("openrouterApiKey");
      state().setDictationAgentCustomApiKey(
        change === "destinations replaced" ? "local-agent" : ""
      );
    }
    release.resolve("");
    await initialization;
    t.mock.timers.tick(250);
    await new Promise(setImmediate);
    const expected = {
      "sources replaced": ["peer-cleanup", "peer-chat"],
      "sources cleared": ["", ""],
      "destinations replaced": ["peer-router", "local-agent"],
      "destinations cleared": ["", ""],
      "occupied destinations": ["router-existing", "agent-existing"],
      "previous migration": ["", ""],
      "main retained an edit": ["", "retained-agent"],
    }[change];
    assert.deepEqual([state().openrouterApiKey, state().dictationAgentCustomApiKey], expected);
    assert.deepEqual(
      [values.get("openrouterApiKey"), values.get("dictationAgentCustomApiKey")],
      expected
    );
    const shouldCopy = change === "sources replaced" || change === "main retained an edit";
    assert.equal(
      saves.filter(([, , migration]) => migration === "if-empty").length,
      shouldCopy ? 2 : 0
    );
    assert.equal(context.storage.getItem("_dictationAgentSeeded"), "1");
    if (change !== "sources cleared")
      assert.equal(context.storage.getItem("_openrouterCustomKeySeeded"), "1");
  });
}

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

test("self-hosted headers hydrate, save per server and refresh across windows without localStorage", async (t) => {
  let stored = JSON.stringify({ dictation: [{ name: "X-API-Key", value: "local-test-key" }] });
  const saved = [];
  const context = await loadSettings(t, {
    getSelfHostedSttHeaders: async () => stored,
    saveSelfHostedSttHeaders: async (value) => {
      stored = value;
      saved.push(value);
    },
  });
  await context.initializeSettings();
  const state = () => context.useSettingsStore.getState();
  assert.deepEqual(state().selfHostedSttHeaders, {
    dictation: [{ name: "X-API-Key", value: "local-test-key" }],
    upload: [],
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Saving the Upload tab's headers leaves dictation's as they were.
  state().setSelfHostedSttHeaders("upload", [
    { name: "X-Upload-Key", value: "upload" },
    { name: "", value: "" },
  ]);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(saved.at(-1)), {
    dictation: [{ name: "X-API-Key", value: "local-test-key" }],
    upload: [{ name: "X-Upload-Key", value: "upload" }],
  });
  assert.equal(context.storage.getItem("selfHostedSttHeaders"), null);

  // Removing the last header (blank rows left behind included) deletes the secret.
  state().setSelfHostedSttHeaders("dictation", []);
  state().setSelfHostedSttHeaders("upload", [{ name: "", value: "" }]);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(saved.at(-1), "");

  stored = JSON.stringify({ upload: [{ name: "X-Other", value: "from-another-window" }] });
  await context.update("selfHostedSttHeaders");
  assert.deepEqual(state().selfHostedSttHeaders, {
    dictation: [],
    upload: [{ name: "X-Other", value: "from-another-window" }],
  });
});
