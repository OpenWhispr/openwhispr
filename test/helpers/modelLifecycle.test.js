const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../../src/models/modelRegistryData.json");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function retire(data, section, providerId, modelId, replacement) {
  const model = data[section].find((p) => p.id === providerId).models.find((m) => m.id === modelId);
  Object.assign(model, { retired: true }, replacement ? { replacement } : {});
  delete model.legacy;
}

test("retired models leave every list but stay resolvable to their replacement", async () => {
  const store = await import("../../src/models/registryData.js");
  const { retiredReplacement, isAwaitingCatalog } =
    await import("../../src/models/modelLifecycle.js");
  const { resolveRetiredCloudModel } = await import("../../src/config/retiredCloudModelPolicy.js");
  const { resolveByokModel } = await import("../../src/helpers/transcriptionRoute.ts");
  const data = structuredClone(seed);
  retire(data, "cloudProviders", "openai", "gpt-5.5", "gpt-6-luna");
  retire(data, "transcriptionProviders", "assemblyai", "universal-3-5-pro");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });

  const openai = store.getRegistryData().cloudProviders.find((p) => p.id === "openai");
  assert.equal(
    openai.models.some((m) => m.id === "gpt-5.5" || m.id === "gpt-4.1-nano"),
    false
  );
  assert.equal(
    store.getRetiredModel("cloudProviders", "openai", "gpt-5.5").replacement,
    "gpt-6-luna"
  );
  assert.equal(
    store.getRegistrySnapshot().data.cloudProviders[0].models.some((m) => m.retired),
    true
  );

  assert.equal(retiredReplacement("cloudProviders", "openai", "gpt-5.5"), "gpt-6-luna");
  assert.equal(resolveRetiredCloudModel("openai", "gpt-5.5"), "gpt-6-luna");
  assert.equal(resolveRetiredCloudModel("openai", "gpt-4.1-nano"), "gpt-6-luna");
  assert.equal(retiredReplacement("cloudProviders", "openai", "gpt-6-luna"), null);
  const assemblyDefault = store
    .getRegistryData()
    .transcriptionProviders.find((p) => p.id === "assemblyai").defaultModel;
  assert.equal(resolveByokModel("assemblyai", "universal-3-5-pro"), assemblyDefault);

  assert.equal(isAwaitingCatalog("cloudProviders", "remote-not-loaded-yet"), false, "not pending");
  store.replaceRegistryData({
    data,
    manifestVersion: store.getRegistryVersion() + 1,
    pending: true,
  });
  assert.equal(isAwaitingCatalog("cloudProviders", "gpt-5.5"), false, "retired is known");
  assert.equal(isAwaitingCatalog("cloudProviders", ""), false, "an empty choice is not awaited");
  assert.equal(isAwaitingCatalog("cloudProviders", "remote-not-loaded-yet"), true);
});

test("startup and live retirements move saved selections and tell the user once", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "openai",
      cleanupModel: "gpt-5.5",
      dictationAgentMode: "providers",
      dictationAgentProvider: "openai",
      dictationAgentModel: "gpt-5.5",
      chatAgentMode: "providers",
      chatAgentProvider: "openai",
      chatAgentModel: "remote-not-loaded-yet",
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "assemblyai",
      cloudTranscriptionModel: "universal-3-5-pro",
    },
    window: { location: { search: "?panel=true" } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const toasts = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const data = structuredClone(seed);
  retire(data, "cloudProviders", "openai", "gpt-5.5", "gpt-6-luna");
  retire(data, "transcriptionProviders", "assemblyai", "universal-3-5-pro");
  store.replaceRegistryData({
    data,
    manifestVersion: store.getRegistryVersion() + 1,
    pending: true,
  });
  settings.reconcileRetiredCloudModelSelections();

  const state = settings.useSettingsStore.getState();
  assert.equal(state.cleanupModel, "gpt-6-luna");
  assert.equal(state.dictationAgentModel, "gpt-6-luna");
  assert.equal(state.chatAgentModel, "remote-not-loaded-yet", "kept while the catalog is pending");
  assert.notEqual(state.cloudTranscriptionModel, "universal-3-5-pro");
  const events = toasts.takeQueuedRetiredModelSwitches();
  assert.deepEqual(
    events.map((event) => [event.provider, event.from]),
    [
      ["openai", "GPT-5.5"],
      ["assemblyai", events[1].from],
    ]
  );
  assert.equal(events[0].providerName, "OpenAI");
  assert.equal(events[0].to, "GPT-6 Luna");
  assert.deepEqual(toasts.takeQueuedRetiredModelSwitches(), [], "each move is shown once");
});

test("without a pending catalog an unknown cloud ID is repaired, as on main", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "openai",
      cleanupModel: "qwen3.5-9b-q4_k_m",
      chatAgentMode: "providers",
      chatAgentProvider: "openai",
      chatAgentModel: "my-self-hosted-model",
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-repair-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  store.replaceRegistryData({
    data: structuredClone(seed),
    manifestVersion: store.getRegistryVersion() + 1,
  });
  settings.reconcileRetiredCloudModelSelections();
  const state = settings.useSettingsStore.getState();
  const openaiDefault = store
    .getRegistryData()
    .cloudProviders.find((p) => p.id === "openai").defaultModel;
  assert.equal(state.cleanupModel, openaiDefault, "a local model in a cloud slot");
  assert.equal(state.chatAgentModel, openaiDefault, "a self-hosted name in a cloud slot");
});

test("a move made while the control panel is closed still reaches it, once", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "openai",
      cleanupModel: "gpt-5.5",
    },
    window: { location: { search: "" } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-panel-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const toasts = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const data = structuredClone(seed);
  retire(data, "cloudProviders", "openai", "gpt-5.5", "gpt-6-luna");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  settings.reconcileRetiredCloudModelSelections();
  assert.equal(settings.useSettingsStore.getState().cleanupModel, "gpt-6-luna");
  assert.deepEqual(toasts.consumeRetiredModelSwitches(), [], "the pill isn't surfaced for this");
  assert.ok(storage.getItem(toasts.QUEUED_SWITCHES_KEY), "waits in storage for the panel");

  // A second window, still holding the old value in memory, makes the same move.
  settings.useSettingsStore.setState({ cleanupModel: "gpt-5.5" });
  storage.setItem("cleanupModel", "gpt-6-luna");
  toasts.takeQueuedRetiredModelSwitches();
  settings.reconcileRetiredCloudModelSelections();
  assert.equal(settings.useSettingsStore.getState().cleanupModel, "gpt-6-luna");
  assert.deepEqual(toasts.takeQueuedRetiredModelSwitches(), [], "the first window told the user");
});

test("only a scope that sends its model hears about a move", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      chatAgentMode: "openwhispr",
      chatAgentProvider: "groq",
      chatAgentModel: "openai/gpt-oss-120b",
    },
    window: { location: { search: "?panel=true" } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-cloud-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const toasts = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const data = structuredClone(seed);
  retire(data, "cloudProviders", "groq", "openai/gpt-oss-120b", "qwen/qwen3.8-27b");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  settings.reconcileRetiredCloudModelSelections();
  assert.equal(settings.useSettingsStore.getState().chatAgentModel, "qwen/qwen3.8-27b");
  assert.deepEqual(toasts.takeQueuedRetiredModelSwitches(), []);
});

test("an unknown model replaced without a retirement says so instead of saying nothing", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "anthropic",
      cleanupModel: "claude-remote-cheap",
    },
    window: { location: { search: "?panel=true" } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-unknown-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const toasts = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const manifestVersion = store.getRegistryVersion() + 1;
  store.replaceRegistryData({ data: structuredClone(seed), manifestVersion, pending: true });
  settings.reconcileRetiredCloudModelSelections();
  assert.equal(settings.useSettingsStore.getState().cleanupModel, "claude-remote-cheap");
  assert.deepEqual(toasts.takeQueuedRetiredModelSwitches(), []);

  store.replaceRegistryData({ data: structuredClone(seed), manifestVersion });
  settings.reconcileRetiredCloudModelSelections();
  const [event] = toasts.takeQueuedRetiredModelSwitches();
  assert.equal(event.from, "claude-remote-cheap");
  assert.equal(event.messageKey, "reasoning.modelUnavailableSwitched");
});

function retireLocal(data, section, id, replacement) {
  Object.assign(data[section][id], { retired: true }, replacement ? { replacement } : {});
  delete data[section][id].legacy;
}

test("a retired local speech model moves every context, and tells only its users", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      useLocalWhisper: "true",
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
      meetingWhisperModel: "base",
      meetingUseLocalWhisper: "false",
      fallbackWhisperModel: "base",
      parakeetModel: "parakeet-tdt-0.6b-v3",
    },
    window: { location: { search: "?panel=true" } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-speech-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const toasts = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const data = structuredClone(seed);
  retireLocal(data, "whisperModels", "base", "turbo");
  // Named across engines: a transducer selection can't hold a Cohere model.
  retireLocal(data, "parakeetModels", "parakeet-tdt-0.6b-v3", "cohere-transcribe-03-2026");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  await settings.reconcileRetiredLocalSpeechSelections();

  const state = settings.useSettingsStore.getState();
  assert.equal(state.whisperModel, "turbo");
  assert.equal(state.meetingWhisperModel, "turbo");
  assert.equal(state.fallbackWhisperModel, "turbo");
  assert.notEqual(state.parakeetModel, "parakeet-tdt-0.6b-v3");
  assert.notEqual(state.parakeetModel, "cohere-transcribe-03-2026");
  assert.ok(store.getRegistryData().parakeetModels[state.parakeetModel]);

  const events = toasts.takeQueuedRetiredModelSwitches();
  assert.equal(events.length, 1, "this user dictates on Whisper, not on Parakeet");
  assert.equal(events[0].messageKey, "reasoning.localModelRetired");
  assert.equal(events[0].to, seed.whisperModels.turbo.name);
});

function speechDisk(downloaded) {
  const status = (model) => ({ success: true, model, downloaded: downloaded.includes(model) });
  return {
    listWhisperModels: async () => ({
      success: true,
      cache_dir: "",
      models: Object.keys(seed.whisperModels).map(status),
    }),
    checkModelStatus: async (model) => status(model),
    listParakeetModels: async () => ({ success: true, cache_dir: "", models: [] }),
    checkParakeetModelStatus: async (model) => status(model),
  };
}

async function reconcileSpeechWith(t, downloaded, cachePrefix) {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      useLocalWhisper: "true",
      localTranscriptionProvider: "whisper",
      whisperModel: "small",
    },
    window: { location: { search: "?panel=true" }, electronAPI: speechDisk(downloaded) },
  });
  const vite = await createRendererServer(t, { cachePrefix });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const toasts = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const data = structuredClone(seed);
  retireLocal(data, "whisperModels", "small", "medium");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  await settings.reconcileRetiredLocalSpeechSelections();
  return { settings, toasts };
}

test("a retired speech model moves to a model on disk before one it would have to download", async (t) => {
  const { settings, toasts } = await reconcileSpeechWith(
    t,
    ["tiny"],
    "model-lifecycle-speech-disk-"
  );
  assert.equal(settings.useSettingsStore.getState().whisperModel, "tiny");
  assert.equal(toasts.takeQueuedRetiredModelSwitches()[0].to, seed.whisperModels.tiny.name);
});

test("a retired file on disk outranks another download, but not its named replacement", async (t) => {
  const kept = await reconcileSpeechWith(t, ["small", "tiny"], "model-lifecycle-speech-keep-");
  assert.equal(kept.settings.useSettingsStore.getState().whisperModel, "small");
  const named = await reconcileSpeechWith(t, ["small", "medium"], "model-lifecycle-speech-named-");
  assert.equal(named.settings.useSettingsStore.getState().whisperModel, "medium");
});

test("a retired multilingual model never moves to an English-only one, or a blocked one", async () => {
  const store = await import("../../src/models/registryData.js");
  const { retiredLocalSpeechReplacement } = await import("../../src/models/modelLifecycle.js");
  const data = structuredClone(seed);
  retireLocal(data, "parakeetModels", "parakeet-tdt-0.6b-v3", "orukeet-v0.1.0");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  const on =
    (...ids) =>
    (id) =>
      ids.includes(id);

  const v3 = "parakeet-tdt-0.6b-v3";
  assert.equal(
    retiredLocalSpeechReplacement("parakeetModels", v3, on("parakeet-tdt-110m-en")),
    "orukeet-v0.1.0"
  );
  assert.equal(
    retiredLocalSpeechReplacement("parakeetModels", v3, on(v3, "parakeet-tdt-110m-en")),
    null
  );
  // A managed org that allows only the retired model keeps it, rather than moving to a
  // blocked file on disk or its blocked replacement.
  assert.equal(
    retiredLocalSpeechReplacement("parakeetModels", v3, on(v3, "orukeet-v0.1.0"), on(v3)),
    null
  );
  assert.equal(
    retiredLocalSpeechReplacement("parakeetModels", v3, on(v3), on("orukeet-v0.1.0")),
    "orukeet-v0.1.0",
    "a blocked retired file is not kept"
  );
  store.replaceRegistryData({
    data: structuredClone(seed),
    manifestVersion: store.getRegistryVersion() + 1,
  });
});

test("an unreadable disk leaves a retired speech selection alone", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      useLocalWhisper: "true",
      localTranscriptionProvider: "whisper",
      whisperModel: "small",
    },
    window: {
      location: { search: "?panel=true" },
      electronAPI: {
        ...speechDisk([]),
        listWhisperModels: async () => {
          throw new Error("EIO");
        },
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-speech-eio-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const data = structuredClone(seed);
  retireLocal(data, "whisperModels", "small", "medium");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  await settings.reconcileRetiredLocalSpeechSelections();
  assert.equal(settings.useSettingsStore.getState().whisperModel, "small");
});

test("a retired meeting model moves to a model meetings can stream", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      meetingTranscriptionMode: "providers",
      meetingCloudTranscriptionMode: "byok",
      meetingUseLocalWhisper: "false",
      meetingCloudTranscriptionProvider: "openai",
      meetingCloudTranscriptionModel: "gpt-4o-mini-transcribe",
    },
    window: { location: { search: "?panel=true" } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-meeting-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const toasts = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const data = structuredClone(seed);
  retire(data, "transcriptionProviders", "openai", "gpt-4o-mini-transcribe", "gpt-transcribe");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  settings.reconcileRetiredCloudModelSelections();

  assert.equal(
    settings.useSettingsStore.getState().meetingCloudTranscriptionModel,
    "gpt-4o-transcribe"
  );
  assert.equal(toasts.takeQueuedRetiredModelSwitches()[0].to, "GPT-4o Transcribe");
});

test("a retired speech model with nothing else on disk keeps running, and says so once", async (t) => {
  const { settings, toasts } = await reconcileSpeechWith(t, ["small"], "model-lifecycle-kept-");
  assert.equal(settings.useSettingsStore.getState().whisperModel, "small");
  assert.deepEqual(
    toasts.takeQueuedRetiredModelSwitches().map((event) => event.messageKey),
    ["reasoning.localModelRetiredKept"]
  );
  await settings.reconcileRetiredLocalSpeechSelections();
  assert.deepEqual(toasts.takeQueuedRetiredModelSwitches(), [], "told once");
});

test("a retired speech model still runs from disk, and Orukeet's cloud languages stay", async () => {
  const store = await import("../../src/models/registryData.js");
  const data = structuredClone(seed);
  retireLocal(data, "whisperModels", "small", "medium");
  retireLocal(data, "parakeetModels", "nemotron-speech-streaming-en-0.6b");
  retireLocal(data, "parakeetModels", "orukeet-v0.1.0");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });

  assert.equal(store.getRegistryData().whisperModels.small, undefined, "no longer offered");
  assert.equal(
    store.getRunnableSpeechModel("whisperModels", "small").fileName,
    seed.whisperModels.small.fileName
  );
  assert.equal(store.getRunnableSpeechModel("whisperModels", "missing"), null);
  const { getModelRuntime } = require("../../src/helpers/parakeetModelInfo");
  assert.equal(getModelRuntime("nemotron-speech-streaming-en-0.6b"), "online");
  const { isOnlineParakeetModel } = await import("../../src/models/ModelRegistry.ts");
  assert.equal(isOnlineParakeetModel("nemotron-speech-streaming-en-0.6b"), true);

  const routing = await import("../../src/helpers/dictationStreamingRouting.js");
  assert.equal(routing.isOrukeetLanguage("en"), true);
  assert.equal(
    routing.shouldRetranscribeOrukeetLanguage({
      language: "auto",
      final: { language: "en", languageConfidence: 0.99, languageAudioSeconds: 5 },
    }),
    false
  );
});

test("a retired GGUF model moves to a replacement on disk, otherwise asks again", async (t) => {
  const provider = seed.localProviders.find((p) => p.models.length > 2 && p.id !== "llama");
  const [retiredOne, replacement, retiredTwo] = provider.models.filter((m) => !m.legacy);
  const installed = [replacement.id];
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      cleanupMode: "local",
      cleanupProvider: provider.id,
      cleanupModel: retiredOne.id,
      chatAgentMode: "local",
      chatAgentProvider: provider.id,
      chatAgentModel: retiredTwo.id,
    },
    window: {
      location: { search: "?panel=true" },
      electronAPI: {
        modelGetAll: async () => installed.map((id) => ({ id, isDownloaded: true })),
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-gguf-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const toasts = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const data = structuredClone(seed);
  retire(data, "localProviders", provider.id, retiredOne.id, replacement.id);
  retire(data, "localProviders", provider.id, retiredTwo.id);
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  await settings.reconcileRetiredLocalLlmSelections();

  const state = settings.useSettingsStore.getState();
  assert.equal(state.cleanupModel, replacement.id);
  assert.equal(state.chatAgentModel, "");
  assert.deepEqual(
    toasts.takeQueuedRetiredModelSwitches().map((event) => event.messageKey),
    ["reasoning.localModelRetired", "reasoning.localModelRetiredChooseAnother"]
  );
});

test("an enterprise scope follows only a named replacement", async (t) => {
  const bedrock = seed.enterpriseProviders.find((p) => p.id === "bedrock");
  const [named, replacement, unnamed] = bedrock.models.filter((m) => !m.retired);
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      _providerSettingsMigrated: "1",
      cleanupMode: "enterprise",
      cleanupProvider: "bedrock",
      cleanupModel: named.id,
      chatAgentMode: "enterprise",
      chatAgentProvider: "bedrock",
      chatAgentModel: unnamed.id,
      noteFormattingMode: "enterprise",
      noteFormattingProvider: "bedrock",
      noteFormattingModel: "my-own-deployment",
    },
    window: { location: { search: "?panel=true" } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-enterprise-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const data = structuredClone(seed);
  retire(data, "enterpriseProviders", "bedrock", named.id, replacement.id);
  retire(data, "enterpriseProviders", "bedrock", unnamed.id);
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  settings.reconcileRetiredCloudModelSelections();

  const state = settings.useSettingsStore.getState();
  assert.equal(state.cleanupModel, replacement.id);
  assert.equal(state.chatAgentModel, unnamed.id);
  assert.equal(state.noteFormattingModel, "my-own-deployment");
});

test("a replacement chain is followed, so skipping publications stays on that line", async () => {
  const store = await import("../../src/models/registryData.js");
  const { retiredReplacement, retiredLocalSpeechReplacement, offeredReplacement } =
    await import("../../src/models/modelLifecycle.js");
  const { resolveRetiredCloudModel } = await import("../../src/config/retiredCloudModelPolicy.js");
  const data = structuredClone(seed);
  retire(data, "cloudProviders", "openai", "gpt-5.5", "gpt-5.6-luna");
  retire(data, "cloudProviders", "openai", "gpt-5.6-luna", "gpt-6-luna");
  retire(data, "cloudProviders", "openai", "gpt-6-luna", "gpt-6.1-sol");
  // A loop must end at the provider's default rather than hang.
  retire(data, "cloudProviders", "openai", "gpt-5.2", "gpt-5-mini");
  retire(data, "cloudProviders", "openai", "gpt-5-mini", "gpt-5.2");
  Object.assign(data.whisperModels.base, { retired: true, replacement: "small" });
  Object.assign(data.whisperModels.small, { retired: true, replacement: "turbo" });
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });

  assert.equal(retiredReplacement("cloudProviders", "openai", "gpt-5.5"), "gpt-6.1-sol");
  const openaiDefault = data.cloudProviders.find((p) => p.id === "openai").defaultModel;
  assert.equal(retiredReplacement("cloudProviders", "openai", "gpt-5.2"), openaiDefault);
  assert.equal(retiredLocalSpeechReplacement("whisperModels", "base"), "turbo");
  assert.equal(
    offeredReplacement("cloudProviders", "openai", "gpt-5.5", (id) => id === "gpt-6.1-sol"),
    "gpt-6.1-sol"
  );
  assert.equal(
    offeredReplacement("cloudProviders", "openai", "gpt-5.5", () => false),
    null
  );
  assert.equal(
    resolveRetiredCloudModel("openai", "gpt-4.1-nano"),
    "gpt-6.1-sol",
    "the static table's target can be retired by the catalog too"
  );
  store.replaceRegistryData({
    data: structuredClone(seed),
    manifestVersion: store.getRegistryVersion() + 1,
  });
});
