const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Main's wrong-script fragment filter falls back to the user's spoken
// languages when the meeting language is auto, so the start options carry them.
test("meeting transcription options carry the user's spoken languages", async (t) => {
  const prepared = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (options) => {
          prepared.push(options);
          return { success: true };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-fragment-languages-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ preferredLanguage: "auto", spokenLanguages: ["en", "ru"] });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  await store.prepareTranscription();

  assert.equal(prepared.length, 1, "prepare must reach main");
  assert.equal(prepared[0].language, undefined);
  assert.deepEqual([...prepared[0].spokenLanguages], ["en", "ru"]);
});
