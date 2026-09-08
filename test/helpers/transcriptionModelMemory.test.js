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

  await t.test("meeting scope restores only streaming-capable models", () => {
    state().switchCloudTranscriptionProvider("meeting", "openai");
    // A remembered batch-only model must not survive into the streaming-filtered
    // meeting scope; the streaming default wins instead.
    const restored = state().meetingCloudTranscriptionModel;
    assert.notEqual(restored, "");
    state().setMeetingCloudTranscriptionModel("gpt-4o-mini-transcribe");
    state().switchCloudTranscriptionProvider("meeting", "groq");
    state().switchCloudTranscriptionProvider("meeting", "openai");
    assert.notEqual(state().meetingCloudTranscriptionModel, "");
  });

  // The picker no longer writes the provider itself — switchCloudTranscriptionProvider
  // is the single writer for both keys, so it must land the provider on its own.
  await t.test("the switch writes the provider key for every scope", () => {
    state().switchCloudTranscriptionProvider("dictation", "groq");
    assert.equal(state().cloudTranscriptionProvider, "groq");
    state().switchCloudTranscriptionProvider("meeting", "openai");
    assert.equal(state().meetingCloudTranscriptionProvider, "openai");
    state().switchCloudTranscriptionProvider("upload", "custom");
    assert.equal(state().uploadCloudTranscriptionProvider, "custom");
  });

  await t.test("an unknown context is a no-op, not a crash", () => {
    const before = { ...state() };
    state().switchCloudTranscriptionProvider("nonexistent", "groq");
    assert.equal(state().cloudTranscriptionProvider, before.cloudTranscriptionProvider);
    assert.equal(state().cloudTranscriptionModel, before.cloudTranscriptionModel);
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

// The picker commits a cloud selection only on an explicit model click:
// switchCloudTranscriptionProvider(ctx, browsedProvider) followed by
// setCloudTranscriptionModel(clickedId). Pin that sequence at store level.
test("explicit model click commits the clicked model, not the remembered one", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionModel: "gpt-4o-transcribe",
      cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
      transcriptionModelByProvider: JSON.stringify({
        "dictation:groq": "whisper-large-v3",
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-model-click-commit-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = () => useSettingsStore.getState();

  state().switchCloudTranscriptionProvider("dictation", "groq");
  state().setCloudTranscriptionModel("whisper-large-v3-turbo");

  assert.equal(state().cloudTranscriptionProvider, "groq");
  assert.equal(
    state().cloudTranscriptionModel,
    "whisper-large-v3-turbo",
    "the clicked model must win over the remembered/default one"
  );
  assert.equal(
    state().transcriptionModelByProvider["dictation:openai"],
    "gpt-4o-transcribe",
    "the outgoing provider's model is remembered"
  );
  assert.equal(
    state().cloudTranscriptionBaseUrl,
    "https://stt.parasail.example.com/v1",
    "the custom URL slot must never be touched by the commit sequence (#1459/#1463)"
  );
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
