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

const DICTATION_URL = "http://192.168.11.83:8090";
const DICTATION_MODEL = "large-v3";
const UPLOAD_URL = "http://192.168.11.84:8090";

// A self-hosted dictation profile from before Audio Upload had its own server.
const SELF_HOSTED_DICTATION = {
  transcriptionMode: "self-hosted",
  uploadTranscriptionMode: "self-hosted",
  remoteTranscriptionUrl: DICTATION_URL,
  remoteTranscriptionModel: DICTATION_MODEL,
};
// The same profile after ≥1.7.3: the upload copy latched before the upload
// self-hosted keys existed, so migrateUploadTranscription() can never seed them.
const LATCHED_SELF_HOSTED = { ...SELF_HOSTED_DICTATION, uploadTranscriptionMigrated: "true" };

// #2049: the Upload tab's Server URL and Model wrote dictation's keys, so the
// two tabs could not point at different servers.
test("audio upload has its own self-hosted server", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-self-hosted-test-",
  });
  // Migrations run once per module evaluation, so every case re-evaluates the store.
  const load = async (seed) => {
    storage.clear();
    for (const [key, value] of Object.entries(seed)) storage.setItem(key, value);
    vite.moduleGraph.invalidateAll();
    const mod = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return { mod, store: mod.useSettingsStore };
  };
  const resolved = (mod, store) => mod.selectResolvedUploadTranscription(store.getState());

  await t.test(
    "the Upload tab's URL and model override dictation's without writing them",
    async () => {
      const { mod, store } = await load({});
      store.getState().setRemoteTranscriptionUrl(DICTATION_URL);
      store.getState().setRemoteTranscriptionModel(DICTATION_MODEL);
      // Unset upload values inherit dictation's, like every other upload field.
      assert.equal(resolved(mod, store).remoteTranscriptionUrl, DICTATION_URL);
      assert.equal(resolved(mod, store).remoteTranscriptionModel, DICTATION_MODEL);

      store.getState().setUploadRemoteTranscriptionUrl(UPLOAD_URL);
      store.getState().setUploadRemoteTranscriptionModel("whisper-diarize");
      const state = store.getState();
      assert.equal(state.remoteTranscriptionUrl, DICTATION_URL, "dictation URL untouched");
      assert.equal(state.remoteTranscriptionModel, DICTATION_MODEL, "dictation model untouched");
      assert.equal(resolved(mod, store).remoteTranscriptionUrl, UPLOAD_URL);
      assert.equal(resolved(mod, store).remoteTranscriptionModel, "whisper-diarize");
    }
  );

  await t.test("an existing self-hosted profile keeps its server on upgrade", async () => {
    for (const [label, seed] of [
      ["pre-1.7.3", SELF_HOSTED_DICTATION],
      ["latched ≥1.7.3", LATCHED_SELF_HOSTED],
    ]) {
      const { mod, store } = await load(seed);
      const state = store.getState();
      assert.equal(state.uploadRemoteTranscriptionUrl, DICTATION_URL, `${label}: URL shown`);
      assert.equal(state.uploadRemoteTranscriptionModel, DICTATION_MODEL, `${label}: model shown`);
      assert.equal(
        resolved(mod, store).remoteTranscriptionUrl,
        DICTATION_URL,
        `${label}: URL used`
      );
      assert.equal(storage.getItem("uploadSelfHostedMigrated"), "true", `${label}: latched`);
    }
  });

  await t.test("the seed copies only keys the upload context lacks, and only once", async () => {
    const kept = await load({ ...LATCHED_SELF_HOSTED, uploadRemoteTranscriptionUrl: UPLOAD_URL });
    assert.equal(kept.store.getState().uploadRemoteTranscriptionUrl, UPLOAD_URL, "not overwritten");
    assert.equal(kept.store.getState().uploadRemoteTranscriptionModel, DICTATION_MODEL);

    const done = await load({ ...LATCHED_SELF_HOSTED, uploadSelfHostedMigrated: "true" });
    assert.equal(storage.getItem("uploadRemoteTranscriptionUrl"), null, "no second copy");
    assert.equal(done.store.getState().uploadRemoteTranscriptionUrl, "");

    await load({});
    assert.equal(storage.getItem("uploadSelfHostedMigrated"), "true", "fresh install latches");
    assert.equal(storage.getItem("uploadRemoteTranscriptionUrl"), null, "nothing to copy");
  });
});
