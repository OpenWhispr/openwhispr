const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../../src/models/modelRegistryData.json");
const { assertCompatibleCatalog } = require("../../src/models/registrySchema.cjs");
const { loadAudioManager } = require("./harness/audioManager");

function nextCatalog() {
  const next = structuredClone(seed);
  for (const [provider, id] of [
    ["openai", "gpt-5-transcribe"],
    ["gemini", "gemini-next-transcribe"],
  ]) {
    next.transcriptionProviders
      .find((p) => p.id === provider)
      .models.push({ id, name: "New batch model", description: "Compatible batch model" });
  }
  assertCompatibleCatalog(next, seed);
  return next;
}

test("new batch selections reach the selected provider without a legacy ID rewrite", async (t) => {
  const store = require("../../src/models/registryData.js");
  const { resolveTranscriptionRoute } = await import("../../src/helpers/transcriptionRoute.ts");
  const old = store.getRegistrySnapshot();
  t.after(() =>
    store.replaceRegistryData({ data: old.data, manifestVersion: old.manifestVersion + 2 })
  );
  store.replaceRegistryData({ data: nextCatalog(), manifestVersion: old.manifestVersion + 1 });
  for (const [provider, model] of [
    ["openai", "gpt-5-transcribe"],
    ["gemini", "gemini-next-transcribe"],
  ]) {
    const route = resolveTranscriptionRoute({
      settings: {
        transcriptionMode: "providers",
        cloudTranscriptionProvider: provider,
        cloudTranscriptionModel: model,
      },
    });
    assert.equal(route.provider, provider);
    assert.equal(route.model, model);
  }
  const wrongProvider = resolveTranscriptionRoute({
    settings: {
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "groq",
      cloudTranscriptionModel: "gpt-5-transcribe",
    },
  });
  assert.equal(wrongProvider.model, "whisper-large-v3-turbo");
});

test("dictation honors a new Gemini batch selection and retains streaming fallbacks", async (t) => {
  const { createManager, setSettings, vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-registry-batch-routing-",
    settingsKey: "__registryBatchRoutingSettings",
  });
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const old = store.getRegistrySnapshot();
  store.replaceRegistryData({ data: nextCatalog(), manifestVersion: old.manifestVersion + 1 });
  const manager = createManager();
  setSettings({
    cloudTranscriptionProvider: "gemini",
    cloudTranscriptionModel: "gemini-next-transcribe",
  });
  assert.equal(manager.getTranscriptionModel(), "gemini-next-transcribe");
  setSettings({
    cloudTranscriptionProvider: "gemini",
    cloudTranscriptionModel: "gemini-3.5-transcribe-live",
  });
  assert.equal(manager.getTranscriptionModel(), "gemini-3.5-transcribe");
  setSettings({
    cloudTranscriptionProvider: "tinfoil",
    cloudTranscriptionModel: "voxtral-mini-4b-realtime",
  });
  assert.equal(manager.getTranscriptionModel(), "voxtral-small-24b");
});
