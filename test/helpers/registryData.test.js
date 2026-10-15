const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../../src/models/modelRegistryData.json");

test("one atomic update reaches CJS helpers, ESM readers and derived model lists", async () => {
  const store = require("../../src/models/registryData.js");
  const esm = await import("../../src/models/registryData.js");
  const { listLocalTranscriptionModels } = require("../../src/helpers/localTranscriptionModels");
  const { getASRModelOrganization } = require("../../src/helpers/localASROrganization.ts");
  const models = require("../../src/models/ModelRegistry.ts");
  const routing = require("../../src/helpers/dictationStreamingRouting.js");
  const old = store.getRegistrySnapshot();
  const next = structuredClone(seed);
  next.whisperModels["registry-test"] = { ...next.whisperModels.base, name: "New whisper" };
  next.parakeetModels["registry-asr"] = { ...next.parakeetModels["orukeet-v0.1.0"] };
  next.cloudProviders[0].models.push({ id: "registry-cloud", name: "New", description: "New" });
  next.localProviders[0].models.push({ ...next.localProviders[0].models[0], id: "registry-local" });
  next.transcriptionProviders
    .find((p) => p.id === "openai")
    .models.push({
      id: "registry-realtime",
      name: "Realtime",
      description: "New",
      streaming: true,
    });
  next.transcriptionProviders
    .find((p) => p.id === "gemini")
    .models.push({ id: "gemini-registry-live", name: "Live", description: "New", streaming: true });
  let events = 0;
  const unsubscribe = store.subscribeRegistry(() => {
    events++;
  });
  models.applyTinfoilModels([{ id: "fresh-tinfoil", name: "Fresh", description: "Overlay" }]);
  try {
    assert.equal(
      store.replaceRegistryData({ data: next, manifestVersion: old.manifestVersion + 1 }),
      true
    );
    assert.equal(events, 1);
    assert.equal(esm.getRegistryData(), store.getRegistryData());
    assert.equal(store.replaceRegistryData(old), false);
    assert.equal(events, 1);
    assert.equal(models.getCloudModel("registry-cloud").name, "New");
    assert.ok(models.modelRegistry.getModel("registry-local"));
    assert.ok(models.WHISPER_MODEL_INFO["registry-test"]);
    assert.ok(models.REASONING_PROVIDERS.openai.models.some((m) => m.value === "registry-cloud"));
    assert.deepEqual(
      models.getTinfoilModels().map((m) => m.id),
      ["fresh-tinfoil"]
    );
    assert.notEqual(
      store.getRegistryData().cloudProviders.find((p) => p.id === "tinfoil").models[0].id,
      "fresh-tinfoil"
    );
    assert.equal(getASRModelOrganization("registry-asr"), "oruk");
    const local = listLocalTranscriptionModels({
      whisperManager: { isModelDownloaded: () => false },
      parakeetManager: { isModelDownloaded: () => false },
      env: {},
    });
    assert.deepEqual(
      local.find((m) => m.model === "registry-test"),
      { provider: "whisper", model: "registry-test", downloaded: false, default: false }
    );
    assert.ok(routing.REALTIME_MODELS.has("registry-realtime"));
    assert.equal(
      routing.isOpenAiRealtimeSelection({
        cloudTranscriptionModel: "registry-realtime",
        cloudTranscriptionMode: "openwhispr",
        cloudTranscriptionProvider: "openai",
      }),
      false
    );
    assert.equal(
      routing.resolveStreamingProviderName({
        settings: {
          cloudTranscriptionProvider: "openai",
          cloudTranscriptionMode: "byok",
          cloudTranscriptionModel: "registry-realtime",
        },
        context: "dictation",
      }),
      "openai-realtime"
    );
    assert.equal(
      routing.resolveStreamingProviderName({
        settings: {
          cloudTranscriptionProvider: "gemini",
          cloudTranscriptionMode: "byok",
          cloudTranscriptionModel: "gemini-registry-live",
        },
        context: "dictation",
      }),
      "gemini"
    );
    assert.equal(
      routing.resolveStreamingProviderName({
        settings: {
          cloudTranscriptionProvider: "groq",
          cloudTranscriptionMode: "byok",
          cloudTranscriptionModel: "registry-realtime",
        },
        context: "notes",
      }),
      "deepgram"
    );
  } finally {
    unsubscribe();
    store.replaceRegistryData({ data: old.data, manifestVersion: old.manifestVersion + 2 });
  }
});
