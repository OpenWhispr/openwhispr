const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Regression for the upload/URL-ingest path dropping diarization metadata: the
// batch queue ran the diarizer but persisted none of diarization_enabled,
// expected_speaker_count, or audio_duration_seconds, so an uploaded note that
// WAS diarized presented to the app as though it was not (the meeting path
// persists all of them).

const transcription = {
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  parakeetModel: "parakeet-tdt-0.6b-v3",
  isOpenWhisprCloud: false,
  getApiKey: () => "",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionBaseUrl: "",
  cloudTranscriptionModel: "whisper-1",
  language: "en",
};

const diarization = { enabled: true, localModelsReady: true, numSpeakers: 2 };

const gateMocks = {
  "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
  "./settingsStore": "export const getSettings = () => ({});",
  "./policyStore": `
    export const usePolicyStore = {
      getState: () => ({}),
      subscribe: () => () => {},
    };
  `,
  "./policyRules": "export const isTranscriptionContextAllowed = () => true;",
  managedLocalTranscriptionRuntime: `
    export const resolveManagedLocalTranscriptionRuntime = (settings) => ({
      kind: 'ready', managed: false, settings,
    });
    export const isManagedLocalTranscriptionRuntimeAllowed = () => true;
    export const captureManagedRuntimeAuthorizationContext = ({ managed, provider, model }) => ({
      accountId: null,
      workspaceId: null,
      authGeneration: null,
      configGeneration: null,
      category: 'transcription',
      provider,
      model,
      managed,
    });
  `,
  runtimeAuthorizationBoundary: `
    export const captureRuntimeAuthorizationLease = (_domains, onChanged) => {
      let current = true;
      const callback = () => {
        if (!current) return;
        current = false;
        onChanged();
      };
      globalThis.__batchAuthorizationCallbacks?.add(callback);
      return {
        isCurrent: () => current,
        assertCurrent() {
          if (!current) throw Object.assign(new Error('Authorization changed'), {
            name: 'AbortError',
            code: 'AUTHORIZATION_BOUNDARY_CHANGED',
          });
        },
        dispose() { globalThis.__batchAuthorizationCallbacks?.delete(callback); },
      };
    };
  `,
};

async function waitForQueueSettled(store, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { queue, isProcessing } = store.getState();
    if (!isProcessing && queue.every((i) => i.status === "done" || i.status === "error")) {
      return queue;
    }
    if (Date.now() > deadline) {
      throw new Error(`queue never settled: ${JSON.stringify(store.getState().queue)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function installUploadElectronAPI(window, { diarizedDurationSeconds }) {
  const calls = {
    saveNote: [],
    updateNote: [],
    transcribe: [],
    diarize: [],
    deletedTempFiles: [],
  };
  Object.assign(window.electronAPI, {
    transcribeAudioFile: async (_filePath, _options, context) => {
      calls.transcribe.push(context);
      return { success: true, text: "hello from the recording" };
    },
    diarizeAudioFile: async (_filePath, options, context) => {
      calls.diarize.push({ options, context });
      return {
        success: true,
        segments: [
          { start: 0, end: 30, speaker: "Speaker 1" },
          { start: 30, end: 60, speaker: "Speaker 2" },
        ],
        durationSeconds: diarizedDurationSeconds,
      };
    },
    mergeSpeakerText: async () => ({ success: true, text: "[Speaker 1] hello [Speaker 2] hi" }),
    saveNote: async (...args) => {
      calls.saveNote.push(args);
      return { success: true, note: { id: 7 } };
    },
    updateNote: async (id, updates) => {
      calls.updateNote.push([id, updates]);
      return { success: true, note: { id } };
    },
    deleteTempFile: (path) => calls.deletedTempFiles.push(path),
    cancelUrlDownload: () => {},
  });
  return calls;
}

test("a diarized file upload persists the diarization metadata", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-diarization-file-test-",
    mockModules: gateMocks,
  });
  // The renderer never knows a picked file's duration up front; the diarizer's
  // measured duration is the only source, so it must land on the note row.
  const calls = installUploadElectronAPI(window, { diarizedDurationSeconds: 4359.87 });

  const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  store.addFiles([{ name: "board-meeting.m4a", path: "/tmp/board-meeting.m4a", sizeBytes: 2048 }]);
  store.processBatchQueue({ transcription, folderId: null }, diarization);

  const queue = await waitForQueueSettled(store.useBatchQueueStore);
  assert.equal(queue[0].status, "done");
  assert.equal(queue[0].noteId, 7);

  assert.equal(calls.saveNote.length, 1);
  const [, content, noteType, sourceFile, audioDuration] = calls.saveNote[0];
  assert.equal(content, "[Speaker 1] hello [Speaker 2] hi");
  assert.equal(noteType, "upload");
  assert.equal(sourceFile, "board-meeting.m4a");
  assert.equal(audioDuration, 4359.87);

  // The persisted count is the same one the diarizer was invoked with.
  assert.equal(calls.diarize.length, 1);
  assert.equal(calls.diarize[0].options.numSpeakers, 2);
  // The diarizer runs under the same cancellable requestId as the
  // transcription, so one cancel-upload-transcription aborts both.
  assert.equal(typeof calls.diarize[0].options.requestId, "string");
  assert.equal(
    calls.diarize[0].context,
    calls.transcribe[0],
    "parallel transcription and diarization must share one captured authorization context"
  );
  assert.deepEqual(calls.updateNote, [[7, { diarization_enabled: 1, expected_speaker_count: 2 }]]);
});

test("a diarized URL ingest persists the diarization metadata", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-diarization-url-test-",
    mockModules: gateMocks,
  });
  // The download's known duration beats the diarizer's measurement.
  const calls = installUploadElectronAPI(window, { diarizedDurationSeconds: 9999 });
  Object.assign(window.electronAPI, {
    onUrlDownloadProgress: () => () => {},
    downloadUrlAudio: async () => ({
      success: true,
      tempPath: "/tmp/ow-url-download.m4a",
      title: "Board Meeting Recording",
      sizeBytes: 4096,
      durationSeconds: 4359.87,
    }),
  });

  const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  store.addUrls(["https://www.youtube.com/watch?v=abc123"]);
  store.processBatchQueue({ transcription, folderId: null }, diarization);

  const queue = await waitForQueueSettled(store.useBatchQueueStore);
  assert.equal(queue[0].status, "done");

  assert.equal(calls.saveNote.length, 1);
  const [title, , noteType, sourceFile, audioDuration] = calls.saveNote[0];
  assert.equal(title, "Board Meeting Recording");
  assert.equal(noteType, "upload");
  assert.equal(sourceFile, "Board Meeting Recording");
  assert.equal(audioDuration, 4359.87);

  assert.deepEqual(calls.updateNote, [[7, { diarization_enabled: 1, expected_speaker_count: 2 }]]);
  assert.deepEqual(calls.deletedTempFiles, ["/tmp/ow-url-download.m4a"]);
});

test("an upload without diarization leaves the note columns untouched", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-diarization-off-test-",
    mockModules: gateMocks,
  });
  const calls = installUploadElectronAPI(window, { diarizedDurationSeconds: 4359.87 });

  const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  store.addFiles([{ name: "memo.m4a", path: "/tmp/memo.m4a", sizeBytes: 2048 }]);
  store.processBatchQueue(
    { transcription, folderId: null },
    { enabled: false, localModelsReady: true, numSpeakers: 2 }
  );

  const queue = await waitForQueueSettled(store.useBatchQueueStore);
  assert.equal(queue[0].status, "done");

  // diarization_enabled must stay null: consumers treat null as "use the
  // global speaker setting" when recording into the note later, and a stored 0
  // would force it off.
  assert.equal(calls.diarize.length, 0);
  assert.equal(calls.updateNote.length, 0);
  assert.equal(calls.saveNote.length, 1);
  assert.equal(calls.saveNote[0][4], null);
});

test("an authorization change cancels a detached batch and prevents later title or save work", async (t) => {
  globalThis.__batchAuthorizationCallbacks = new Set();
  t.after(() => delete globalThis.__batchAuthorizationCallbacks);
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-batch-auth-boundary-test-",
    mockModules: gateMocks,
  });
  let resolveTranscription;
  const transcriptionResult = new Promise((resolve) => {
    resolveTranscription = resolve;
  });
  const transcriptionRequests = [];
  const cancelledRequests = [];
  const savedNotes = [];
  Object.assign(window.electronAPI, {
    transcribeAudioFile: async (_path, options) => {
      transcriptionRequests.push(options.requestId);
      return transcriptionResult;
    },
    cancelUploadTranscription: async (requestId) => {
      cancelledRequests.push(requestId);
      return { success: true };
    },
    cancelUrlDownload() {},
    saveNote: async (...args) => {
      savedNotes.push(args);
      return { success: true, note: { id: 17 } };
    },
  });
  let titleCalls = 0;
  const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  store.addFiles([
    { name: "first.m4a", path: "/tmp/first.m4a", sizeBytes: 100 },
    { name: "second.m4a", path: "/tmp/second.m4a", sizeBytes: 100 },
  ]);
  store.processBatchQueue(
    {
      transcription,
      folderId: null,
      generateTitle: async () => {
        titleCalls += 1;
        return "Generated";
      },
    },
    { enabled: false, localModelsReady: false, numSpeakers: null }
  );
  while (transcriptionRequests.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  for (const callback of [...globalThis.__batchAuthorizationCallbacks]) callback();
  resolveTranscription({ success: true, text: "late transcript" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(cancelledRequests, [transcriptionRequests[0]]);
  assert.equal(transcriptionRequests.length, 1);
  assert.equal(titleCalls, 0);
  assert.equal(savedNotes.length, 0);
  assert.equal(store.useBatchQueueStore.getState().isProcessing, false);
  assert.deepEqual(
    store.useBatchQueueStore.getState().queue.map((item) => item.status),
    ["error", "error"]
  );
});
