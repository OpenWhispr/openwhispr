const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { createUploadCancelRegistry } = require("../../src/helpers/uploadCancelRegistry");
const { deferred } = require("../helpers/harness/deferred");

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
  const lookup = deferred();
  const registry = createUploadCancelRegistry();
  let submittedKey;
  window.electronAPI.resolveSecretRef = () => lookup.promise;
  window.electronAPI.transcribeAudioFileByok = async ({ apiKey, requestId }) => {
    submittedKey = apiKey;
    const { signal } = registry.register(requestId);
    await lookup.promise;
    if (signal.aborted) return { success: false, code: "UPLOAD_CANCELLED" };
    return { success: true, text: "hello" };
  };

  const upload = transcribeFileWithSpeakers(
    "/tmp/meeting.mp3",
    {
      useLocalWhisper: false,
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
      parakeetModel: "parakeet-tdt-0.6b-v3",
      cohereModel: "",
      isOpenWhisprCloud: false,
      getApiKey: () => "$OPENROUTER_API_KEY",
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

  const cancelled = registry.cancel("upload-7");
  lookup.resolve("synthetic-openrouter");
  const result = await upload;
  assert.equal(cancelled, 1);
  assert.equal(result.code, "UPLOAD_CANCELLED");
  assert.equal(submittedKey, "$OPENROUTER_API_KEY");
});

test("an abandoned voice take skips cloud dispatch on a session refresh retry", async (t) => {
  const { window } = installBrowserGlobals(t);
  const cancellation = new AbortController();
  let attempts = 0;
  window.electronAPI.transcribeAudioFileCloud = async () => {
    attempts++;
    cancellation.abort();
    return { success: false, code: "AUTH_EXPIRED" };
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-cloud-cancel-test-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn().catch(() => fn());",
      "./managedTranscription": "export const getManagedTranscriptionResolution = () => null;",
    },
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");
  await assert.rejects(
    transcribeFile("/tmp/take.webm", { isOpenWhisprCloud: true }, false, {
      requestId: "voice-take",
      signal: cancellation.signal,
    }),
    { name: "AbortError" }
  );
  assert.equal(attempts, 1);
});
