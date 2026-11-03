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
  const { retiredReplacement, isUnknownModel } = await import("../../src/models/modelLifecycle.js");
  const { resolveRetiredCloudModel } = await import("../../src/config/retiredCloudModelPolicy.js");
  const { resolveByokModel } = await import("../../src/helpers/transcriptionRoute.ts");
  const data = structuredClone(seed);
  retire(data, "cloudProviders", "openai", "gpt-5.5", "gpt-6-luna");
  retire(data, "transcriptionProviders", "assemblyai", "universal-3-5-pro");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });

  const openai = store.getRegistryData().cloudProviders.find((p) => p.id === "openai");
  assert.equal(openai.models.some((m) => m.id === "gpt-5.5" || m.id === "gpt-4.1-nano"), false);
  assert.equal(store.getRetiredModel("cloudProviders", "openai", "gpt-5.5").replacement, "gpt-6-luna");
  assert.equal(store.getRegistrySnapshot().data.cloudProviders[0].models.some((m) => m.retired), true);

  assert.equal(retiredReplacement("cloudProviders", "openai", "gpt-5.5"), "gpt-6-luna");
  assert.equal(resolveRetiredCloudModel("openai", "gpt-5.5"), "gpt-6-luna");
  assert.equal(resolveRetiredCloudModel("openai", "gpt-4.1-nano"), "gpt-6-luna");
  assert.equal(retiredReplacement("cloudProviders", "openai", "gpt-6-luna"), null);
  const assemblyDefault = store
    .getRegistryData()
    .transcriptionProviders.find((p) => p.id === "assemblyai").defaultModel;
  assert.equal(resolveByokModel("assemblyai", "universal-3-5-pro"), assemblyDefault);

  assert.equal(isUnknownModel("cloudProviders", "gpt-5.5"), false, "retired is known");
  assert.equal(isUnknownModel("cloudProviders", "remote-not-loaded-yet"), true);
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
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-lifecycle-" });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const toasts = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  const data = structuredClone(seed);
  retire(data, "cloudProviders", "openai", "gpt-5.5", "gpt-6-luna");
  retire(data, "transcriptionProviders", "assemblyai", "universal-3-5-pro");
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  settings.reconcileRetiredCloudModelSelections();

  const state = settings.useSettingsStore.getState();
  assert.equal(state.cleanupModel, "gpt-6-luna");
  assert.equal(state.dictationAgentModel, "gpt-6-luna");
  assert.equal(state.chatAgentModel, "remote-not-loaded-yet", "unknown IDs are left alone");
  assert.notEqual(state.cloudTranscriptionModel, "universal-3-5-pro");
  const events = toasts.consumeRetiredModelSwitches();
  assert.deepEqual(
    events.map((event) => [event.provider, event.from]),
    [
      ["openai", "GPT-5.5"],
      ["assemblyai", events[1].from],
    ]
  );
  assert.equal(events[0].providerName, "OpenAI");
  assert.equal(events[0].to, "GPT-6 Luna");
});
