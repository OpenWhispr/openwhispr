const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// OpenRouter forwards only punctuate/diarize/smart_format/detect_language to
// Deepgram, so the user's dictionary never reaches Nova-3 through it. Dictation
// leans on the dictionary, so the model is offered in Audio Upload only.
const DEEPGRAM_VIA_OPENROUTER = "deepgram/nova-3";

const load = () => import("../../src/models/ModelRegistry.ts");

test("the registry offers Deepgram via OpenRouter to Upload only", async () => {
  const { getTranscriptionProviders, getDictationTranscriptionProviders } = await load();
  const { isUploadOnlyTranscriptionModel } = await import("../../src/stores/policyRules.ts");
  const ids = (providers) =>
    providers.find((provider) => provider.id === "openrouter").models.map((model) => model.id);

  assert.ok(ids(getTranscriptionProviders()).includes(DEEPGRAM_VIA_OPENROUTER));
  assert.ok(!ids(getDictationTranscriptionProviders()).includes(DEEPGRAM_VIA_OPENROUTER));
  assert.ok(ids(getDictationTranscriptionProviders()).includes("openai/gpt-transcribe"));
  assert.equal(isUploadOnlyTranscriptionModel("openrouter", DEEPGRAM_VIA_OPENROUTER), true);
  // Direct Deepgram already sends the dictionary as keyterm; it is untouched.
  assert.equal(isUploadOnlyTranscriptionModel("deepgram", "nova-3"), false);
});

test("a remembered Deepgram-via-OpenRouter pick survives in Upload, not dictation", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      cloudTranscriptionProvider: "groq",
      cloudTranscriptionModel: "whisper-large-v3-turbo",
      // Its own provider, or Upload inherits dictation's and the switch is a no-op.
      uploadCloudTranscriptionProvider: "groq",
      uploadCloudTranscriptionModel: "whisper-large-v3-turbo",
      transcriptionModelByProvider: JSON.stringify({
        "dictation:openrouter": DEEPGRAM_VIA_OPENROUTER,
        "upload:openrouter": DEEPGRAM_VIA_OPENROUTER,
      }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-openrouter-deepgram-upload-only-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = () => useSettingsStore.getState();

  state().switchCloudTranscriptionProvider("dictation", "openrouter");
  assert.equal(state().cloudTranscriptionModel, "openai/gpt-transcribe");

  state().switchCloudTranscriptionProvider("upload", "openrouter");
  assert.equal(state().uploadCloudTranscriptionModel, DEEPGRAM_VIA_OPENROUTER);
});
