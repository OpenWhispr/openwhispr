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
  settings.reconcileRetiredLocalSpeechSelections();

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
