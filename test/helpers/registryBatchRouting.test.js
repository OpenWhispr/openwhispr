const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../../src/models/modelRegistryData.json");
const { acceptCatalog, assertCompatibleCatalog } = require("../../src/models/registrySchema.cjs");
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

test("Gemini batch routes honor model retirements after a catalog update", async (t) => {
  const store = require("../../src/models/registryData.js");
  const { resolveTranscriptionRoute } = await import("../../src/helpers/transcriptionRoute.ts");
  const previous = store.getRegistrySnapshot();
  t.after(() =>
    store.replaceRegistryData({ ...previous, manifestVersion: store.getRegistryVersion() + 1 })
  );

  for (const batchSuccessor of ["gemini-next-transcribe", "gemini-next-transcribe-live"]) {
    await t.test(`retired batch model points to ${batchSuccessor}`, () => {
      const catalog = nextCatalog();
      const gemini = catalog.transcriptionProviders.find((provider) => provider.id === "gemini");
      gemini.models.push({
        id: "gemini-next-transcribe-live",
        name: "New Live model",
        description: "Streaming transcription",
        streaming: true,
      });
      gemini.defaultModel = "gemini-next-transcribe";
      const oldBatch = gemini.models.find((model) => model.id === "gemini-3.5-transcribe");
      const oldLive = gemini.models.find((model) => model.id === "gemini-3.5-transcribe-live");
      Object.assign(oldBatch, { retired: true, replacement: batchSuccessor });
      Object.assign(oldLive, {
        retired: true,
        replacement: "gemini-next-transcribe-live",
      });
      assertCompatibleCatalog(catalog, seed);
      store.replaceRegistryData({
        data: acceptCatalog(catalog, seed, require("../../package.json").version),
        manifestVersion: store.getRegistryVersion() + 1,
      });

      for (const model of [
        "gemini-next-transcribe-live",
        "gemini-3.5-transcribe-live",
        "gemini-3.5-transcribe",
      ]) {
        const route = resolveTranscriptionRoute({
          settings: {
            transcriptionMode: "providers",
            cloudTranscriptionProvider: "gemini",
            cloudTranscriptionModel: model,
          },
        });
        assert.equal(route.model, "gemini-next-transcribe", `batch route for ${model}`);
      }
    });
  }
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
