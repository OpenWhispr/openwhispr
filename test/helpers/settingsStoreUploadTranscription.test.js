const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Upload inherits unset values from dictation, but a realtime-only dictation
// provider has no batch route — inheriting it would fail every upload closed
// on transcriptionRoute's guard. The picker hides those providers for the
// upload scope and reconciles an unset selection to the first provider, so the
// resolved value must land on the same default.
test("upload transcription never inherits a realtime-only dictation provider", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-transcription-test-",
  });
  const { useSettingsStore, selectResolvedUploadTranscription } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { STREAMING_ONLY_PROVIDERS } = await vite.ssrLoadModule("/helpers/transcriptionRoute.ts");
  const base = useSettingsStore.getState();

  for (const provider of STREAMING_ONLY_PROVIDERS) {
    const resolved = selectResolvedUploadTranscription({
      ...base,
      cloudTranscriptionProvider: provider,
      cloudTranscriptionModel: "nova-3",
      uploadCloudTranscriptionProvider: "",
      uploadCloudTranscriptionModel: "",
    });
    assert.equal(resolved.cloudTranscriptionProvider, "openai", provider);
    assert.equal(resolved.cloudTranscriptionModel, "", `${provider}'s model must not follow`);
  }

  // An explicit upload choice always wins, even a realtime-only one — the
  // route guard then reports it truthfully instead of silently rerouting.
  const explicit = selectResolvedUploadTranscription({
    ...base,
    cloudTranscriptionProvider: "deepgram",
    uploadCloudTranscriptionProvider: "groq",
    uploadCloudTranscriptionModel: "whisper-large-v3",
  });
  assert.equal(explicit.cloudTranscriptionProvider, "groq");
  assert.equal(explicit.cloudTranscriptionModel, "whisper-large-v3");

  // Batch-capable dictation providers keep inheriting provider and model.
  const inherited = selectResolvedUploadTranscription({
    ...base,
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "whisper-large-v3-turbo",
    uploadCloudTranscriptionProvider: "",
    uploadCloudTranscriptionModel: "",
  });
  assert.equal(inherited.cloudTranscriptionProvider, "groq");
  assert.equal(inherited.cloudTranscriptionModel, "whisper-large-v3-turbo");
});
