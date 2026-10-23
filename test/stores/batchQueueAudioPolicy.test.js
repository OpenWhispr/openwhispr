const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const transcription = { getApiKey: () => "", useLocalWhisper: true };
const diarization = { enabled: false, modelsReady: false, numSpeakers: null };

async function setup(t) {
  const cancelled = [];
  const calls = [];
  const saved = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cancelUploadTranscription: (id) => cancelled.push(id),
        cancelUrlDownload() {},
        deleteTempFile() {},
      },
    },
  });
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  globalThis.__audioPolicyBatch = { calls, saved, pending };
  t.after(() => {
    delete globalThis.__audioPolicyBatch;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-policy-batch-",
    mockModules: {
      "/services/fileTranscription": `export async function transcribeFileWithSpeakers(...args) { globalThis.__audioPolicyBatch.calls.push(args); return globalThis.__audioPolicyBatch.pending; }`,
      "/services/managedTranscription": `export const isManagedTranscriptionActive = () => true;`,
      "/services/uploadNotes": `export async function saveUploadNote(...args) { globalThis.__audioPolicyBatch.saved.push(args); return { success: true, note: { id: 7 } }; } export const uploadTitleFallback = () => "Audio";`,
      "/stores/settingsStore": `export const getSettings = () => ({});`,
      "/components/notes/shared": `export const DOWNLOAD_ERROR_KEYS = {}; export const transcriptionErrorKey = () => null;`,
    },
  });
  const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const setPolicy = (meetingRecordingEnabled, audioUploadEnabled) =>
    usePolicyStore.setState({
      status: "managed",
      appVersion: "1.11.0",
      policy: { minAppVersion: null, features: { meetingRecordingEnabled, audioUploadEnabled } },
    });
  setPolicy(true, true);
  store.addFiles([
    { name: "one.wav", path: "/tmp/one.wav", sizeBytes: 1 },
    { name: "two.wav", path: "/tmp/two.wav", sizeBytes: 1 },
  ]);
  return { store, calls, saved, cancelled, finish, setPolicy };
}

test("upload restrictions prevent a managed-provider batch from starting", async (t) => {
  const { store, calls, setPolicy } = await setup(t);
  setPolicy(true, false);
  store.processBatchQueue({ transcription, folderId: null }, diarization);
  assert.equal(store.useBatchQueueStore.getState().isProcessing, false);
  assert.equal(calls.length, 0);
});

test("an upload restriction cancels an active batch and discards late results; meeting-only restrictions leave it running", async (t) => {
  const { store, calls, saved, cancelled, finish, setPolicy } = await setup(t);
  store.processBatchQueue({ transcription, folderId: null }, diarization);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  setPolicy(false, true);
  assert.equal(store.useBatchQueueStore.getState().isProcessing, true);
  assert.equal(cancelled.length, 0);
  setPolicy(false, false);
  assert.equal(store.useBatchQueueStore.getState().isProcessing, false);
  assert.equal(cancelled.length, 1);
  finish({ success: true, text: "late result" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(saved.length, 0);
  assert.ok(store.useBatchQueueStore.getState().queue.every((item) => item.status === "error"));
});
