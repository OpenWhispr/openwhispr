const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const en = require("../../src/locales/en/translation.json");

const transcription = { getApiKey: () => "", useLocalWhisper: true };
const diarization = { enabled: false, modelsReady: false, numSpeakers: null };
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

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
  // Each transcription waits until the test settles it through `results[i]`.
  const results = [];
  globalThis.__audioPolicyBatch = {
    calls,
    saved,
    transcribe: () =>
      new Promise((resolve) => {
        results.push(resolve);
      }),
  };
  t.after(() => {
    delete globalThis.__audioPolicyBatch;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-policy-batch-",
    mockModules: {
      "/services/fileTranscription": `export async function transcribeFileWithSpeakers(...args) { globalThis.__audioPolicyBatch.calls.push(args); return globalThis.__audioPolicyBatch.transcribe(); }`,
      "/services/managedTranscription": `export const isManagedTranscriptionActive = () => true;`,
      "/services/uploadNotes": `export async function saveUploadNote(...args) { globalThis.__audioPolicyBatch.saved.push(args); return { success: true, note: { id: 7 } }; } export const uploadTitleFallback = () => "Audio";`,
      "/stores/settingsStore": `export const getSettings = () => ({});`,
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
  const run = async () => {
    store.processBatchQueue({ transcription, folderId: null }, diarization);
    await flush();
  };
  const items = () =>
    store.useBatchQueueStore
      .getState()
      .queue.map(({ status, error, stoppedByPolicy }) => ({ status, error, stoppedByPolicy }));
  return { store, calls, saved, cancelled, results, setPolicy, usePolicyStore, run, items };
}

test("upload restrictions prevent a managed-provider batch from starting", async (t) => {
  const { store, calls, setPolicy } = await setup(t);
  setPolicy(true, false);
  store.processBatchQueue({ transcription, folderId: null }, diarization);
  assert.equal(store.useBatchQueueStore.getState().isProcessing, false);
  assert.equal(calls.length, 0);
});

test("an upload restriction cancels an active batch and discards late results; meeting-only restrictions leave it running", async (t) => {
  const { store, calls, saved, cancelled, results, setPolicy, run, items } = await setup(t);
  await run();
  assert.equal(calls.length, 1);
  setPolicy(false, true);
  assert.equal(store.useBatchQueueStore.getState().isProcessing, true);
  assert.equal(cancelled.length, 0);
  setPolicy(false, false);
  assert.equal(store.useBatchQueueStore.getState().isProcessing, false);
  assert.equal(cancelled.length, 1);
  results[0]({ success: true, text: "late result" });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(saved.length, 0);
  assert.deepEqual(
    items(),
    [
      { status: "error", error: en.notes.upload.disabledByOrg, stoppedByPolicy: true },
      { status: "queued", error: undefined, stoppedByPolicy: undefined },
    ],
    "the item in flight names the org; the rest wait to be retried"
  );
});

test("a batch stopped by policy shows the page banner's reason for that policy", async (t) => {
  for (const [policy, expected] of [
    [{ status: "error", policy: null }, en.common.policyUnresolved],
    [{ status: "loading", policy: null }, en.common.policyUnresolved],
    [
      {
        status: "managed",
        appVersion: "1.0.0",
        policy: { minAppVersion: "1.11.0", features: { audioUploadEnabled: true } },
      },
      en.common.policyTranscriptionRestricted,
    ],
  ]) {
    const { usePolicyStore, run, items } = await setup(t);
    await run();
    usePolicyStore.setState(policy);
    assert.equal(items()[0].error, expected, policy.status);
  }
});

test("a server's policy refusal ends the run and leaves the rest queued", async (t) => {
  const { store, calls, results, run, items } = await setup(t);
  await run();
  results[0]({ success: false, code: "POLICY_AUDIO_UPLOAD_DISABLED", error: "raw server text" });
  await flush();

  assert.equal(calls.length, 1, "the next item isn't sent to be refused too");
  assert.equal(store.useBatchQueueStore.getState().isProcessing, false);
  assert.deepEqual(items(), [
    { status: "error", error: "disabledByOrg", stoppedByPolicy: true },
    { status: "queued", error: undefined, stoppedByPolicy: undefined },
  ]);
});

test("Transcribe retries the item policy stopped along with the rest once uploads are allowed", async (t) => {
  const { calls, saved, results, setPolicy, run, items } = await setup(t);
  await run();
  setPolicy(true, false);
  await run();
  assert.equal(calls.length, 1, "Transcribe stays refused while uploads are off");
  assert.equal(items()[0].stoppedByPolicy, true, "the reason stays shown until then");

  setPolicy(true, true);
  await run();
  results[1]({ success: true, text: "One" });
  await flush();
  results[2]({ success: true, text: "Two" });
  await flush();

  assert.deepEqual(
    calls.slice(1).map(([path]) => path),
    ["/tmp/one.wav", "/tmp/two.wav"]
  );
  assert.equal(saved.length, 2);
  assert.deepEqual(
    items().map(({ status }) => status),
    ["done", "done"]
  );
});

test("Cancel all still cancels every unfinished item", async (t) => {
  const { store, run, items } = await setup(t);
  await run();
  store.cancelBatch();
  assert.deepEqual(
    items().map(({ status, error }) => ({ status, error })),
    [
      { status: "error", error: "batchCancelled" },
      { status: "error", error: "batchCancelled" },
    ]
  );
});
