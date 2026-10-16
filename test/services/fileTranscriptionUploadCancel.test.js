const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Cancelling a long OpenRouter upload must reach the main process, or every
// remaining piece is still sent and billed. Both the single-file view and the
// batch queue pass their requestId through transcribeFileWithSpeakers.
test("a bring-your-own-key upload hands its cancel id to the main process", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-upload-cancel-test-",
    mockModules: { "/lib/auth": "export const withSessionRefresh = (fn) => fn();" },
  });
  const { transcribeFileWithSpeakers } = await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  );
  let received = null;
  window.electronAPI.transcribeAudioFileByok = async (options) => {
    received = options;
    return { success: true, text: "hello" };
  };

  await transcribeFileWithSpeakers(
    "/tmp/meeting.mp3",
    {
      useLocalWhisper: false,
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
      parakeetModel: "parakeet-tdt-0.6b-v3",
      cohereModel: "",
      isOpenWhisprCloud: false,
      getApiKey: () => "ork-openrouter",
      cloudTranscriptionProvider: "openrouter",
      cloudTranscriptionBaseUrl: "",
      cloudTranscriptionModel: "google/chirp-3",
      language: "",
      transcriptionMode: "providers",
    },
    { enabled: false, localModelsReady: false, numSpeakers: null },
    null,
    { requestId: "upload-7", timestamps: true }
  );

  assert.equal(received.requestId, "upload-7");
});
