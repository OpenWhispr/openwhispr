const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function waitForQueueCompletion(useBatchQueueStore) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!useBatchQueueStore.getState().isProcessing) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Batch queue did not finish");
}

test("batch uploads retain diarization warnings separately from transcription warnings", async (t) => {
  installBrowserGlobals(t);
  globalThis.__batchDiarizationResult = {
    success: true,
    text: "Plain transcript",
    diarizationWarning: true,
  };
  t.after(() => {
    delete globalThis.__batchDiarizationResult;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-batch-diarization-warning-test-",
    mockModules: {
      "/services/fileTranscription": `
        export async function transcribeFileWithSpeakers() {
          return globalThis.__batchDiarizationResult;
        }
      `,
      "/components/notes/shared": `
        export const DOWNLOAD_ERROR_KEYS = {};
        export function transcriptionErrorKey() { return null; }
      `,
      "/services/uploadNotes": `
        export async function saveUploadNote() {
          return { success: true, note: { id: 42 } };
        }
        export function uploadTitleFallback() { return "Uploaded note"; }
      `,
      "/stores/settingsStore": "export function getSettings() { return {}; }",
      "/stores/policyRules":
        "export function isTranscriptionContextAllowed() { return true; }",
      "/stores/policyStore": `
        export const usePolicyStore = { getState() { return {}; } };
      `,
    },
  });
  const { addFiles, processBatchQueue, useBatchQueueStore } = await vite.ssrLoadModule(
    "/stores/batchQueueStore.ts"
  );

  addFiles([{ name: "interview.wav", path: "/tmp/interview.wav", sizeBytes: 1024 }]);
  processBatchQueue(
    {
      transcription: {
        useLocalWhisper: true,
        localTranscriptionProvider: "nvidia",
        whisperModel: "base",
        parakeetModel: "parakeet-tdt-0.6b-v3",
        cohereModel: "command-a-transcribe",
        isOpenWhisprCloud: false,
        getApiKey: () => "",
        cloudTranscriptionProvider: "openai",
        cloudTranscriptionBaseUrl: "",
        cloudTranscriptionModel: "whisper-1",
        language: "en",
      },
      folderId: null,
    },
    { enabled: true, localModelsReady: true, numSpeakers: null }
  );
  await waitForQueueCompletion(useBatchQueueStore);

  const [item] = useBatchQueueStore.getState().queue;
  assert.equal(item.status, "done");
  assert.equal(item.warning, false);
  assert.equal(item.diarizationWarning, true);
  assert.equal(item.noteId, 42);
});
