const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Regression for #2049: Dictation and Audio Upload both read/wrote the same
// shared `remoteTranscriptionUrl` key, so changing one silently changed the
// other despite the Settings UI presenting them as independent tabs.
// `uploadRemoteTranscriptionUrl` gives Audio Upload its own key (falling back
// to the shared value when unset), mirroring the existing meeting-context
// pattern (`meetingRemoteTranscriptionUrl`).
test("audio upload self-hosted URL is isolated from dictation's", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-remote-url-test-",
  });
  const { useSettingsStore, selectResolvedUploadTranscription } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );

  // No upload-specific override yet: falls back to the shared (dictation) URL.
  useSettingsStore.getState().setRemoteTranscriptionUrl("http://dictation-server:8090");
  let resolved = selectResolvedUploadTranscription(useSettingsStore.getState());
  assert.equal(resolved.remoteTranscriptionUrl, "http://dictation-server:8090");

  // Setting Audio Upload's URL must not clobber Dictation's.
  useSettingsStore.getState().setUploadRemoteTranscriptionUrl("http://upload-server:8090");
  assert.equal(
    useSettingsStore.getState().remoteTranscriptionUrl,
    "http://dictation-server:8090",
    "dictation's shared URL must be unchanged"
  );
  resolved = selectResolvedUploadTranscription(useSettingsStore.getState());
  assert.equal(resolved.remoteTranscriptionUrl, "http://upload-server:8090");
});
