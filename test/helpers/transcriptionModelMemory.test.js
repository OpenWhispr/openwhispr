const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("per-provider transcription model memory", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionModel: "parasail-whisper-v3",
      cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-model-memory-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = () => useSettingsStore.getState();

  await t.test("switch-and-return restores the custom model (Parasail scenario)", () => {
    state().switchCloudTranscriptionProvider("dictation", "tinfoil");
    assert.equal(state().cloudTranscriptionProvider, "tinfoil");
    assert.notEqual(state().cloudTranscriptionModel, "parasail-whisper-v3");
    assert.equal(
      state().cloudTranscriptionBaseUrl,
      "https://stt.parasail.example.com/v1",
      "the custom URL slot must never be touched by a provider switch"
    );

    state().switchCloudTranscriptionProvider("dictation", "custom");
    assert.equal(state().cloudTranscriptionProvider, "custom");
    assert.equal(state().cloudTranscriptionModel, "parasail-whisper-v3");
  });

  await t.test("reselecting the current provider keeps the current model", () => {
    state().setCloudTranscriptionModel("parasail-tuned");
    state().switchCloudTranscriptionProvider("dictation", "custom");
    assert.equal(state().cloudTranscriptionModel, "parasail-tuned");
  });

  await t.test("a remembered model that no longer matches the provider falls back", () => {
    state().switchCloudTranscriptionProvider("dictation", "groq");
    state().setCloudTranscriptionModel("retired-groq-model");
    state().switchCloudTranscriptionProvider("dictation", "custom");
    state().switchCloudTranscriptionProvider("dictation", "groq");
    assert.notEqual(
      state().cloudTranscriptionModel,
      "retired-groq-model",
      "an unknown remembered model must degrade to the provider default"
    );
    assert.match(state().cloudTranscriptionModel, /^whisper-large-v3/);
  });

  await t.test("scopes have independent memory and writes", () => {
    state().switchCloudTranscriptionProvider("dictation", "custom");
    const dictationModel = state().cloudTranscriptionModel;

    state().switchCloudTranscriptionProvider("upload", "groq");
    assert.equal(state().uploadCloudTranscriptionProvider, "groq");
    assert.match(state().uploadCloudTranscriptionModel, /^whisper-large-v3/);
    assert.equal(state().cloudTranscriptionProvider, "custom", "base scope untouched");
    assert.equal(state().cloudTranscriptionModel, dictationModel, "base scope untouched");
  });

  await t.test("memory persists to localStorage as JSON", () => {
    const persisted = JSON.parse(localStorage.getItem("transcriptionModelByProvider"));
    assert.equal(typeof persisted, "object");
    assert.ok(Object.keys(persisted).some((key) => key.startsWith("dictation:")));
  });

  await t.test("setCloudTranscriptionForAllScopes seeds memory in every scope", () => {
    state().setCloudTranscriptionForAllScopes({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionModel: "corti-transcribe",
    });
    const memory = state().transcriptionModelByProvider;
    for (const context of ["dictation", "meeting", "upload"]) {
      assert.equal(memory[`${context}:corti`], "corti-transcribe");
    }
  });
});

test("corrupt persisted model memory hydrates as empty, not a crash", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      transcriptionModelByProvider: "{not json",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-model-memory-corrupt-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.deepEqual(useSettingsStore.getState().transcriptionModelByProvider, {});
});
