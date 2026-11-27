const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The upload flows opt into segment timestamps (issue #1095): the flag must
// reach the BYOK IPC call, and the segments the handler returns must survive
// transcribeFileWithSpeakers' result spread so saveUploadNote can persist them.

function byokConfig() {
  return {
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    isOpenWhisprCloud: false,
    getApiKey: () => "sk-test",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "whisper-1",
    language: "en",
    transcriptionMode: "providers",
  };
}

test("timestamps opt-in reaches the BYOK IPC call and segments flow back", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-timestamps-test-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { transcribeFile, transcribeFileWithSpeakers } = await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  );

  const segments = [{ text: "Hello.", start: 0, end: 2.5 }];
  let receivedOptions = null;
  window.electronAPI.transcribeAudioFileByok = async (options) => {
    receivedOptions = options;
    return { success: true, text: "Hello.", segments };
  };

  const direct = await transcribeFile("/tmp/audio.webm", byokConfig(), false, {
    timestamps: true,
  });
  assert.equal(receivedOptions.timestamps, true);
  assert.deepEqual(direct.segments, segments);

  // Without the opt-in the request stays exactly as before.
  await transcribeFile("/tmp/audio.webm", byokConfig(), false);
  assert.equal(receivedOptions.timestamps, undefined);

  const withSpeakers = await transcribeFileWithSpeakers(
    "/tmp/audio.webm",
    byokConfig(),
    { enabled: false, localModelsReady: false, numSpeakers: null },
    120,
    { timestamps: true }
  );
  assert.equal(receivedOptions.timestamps, true);
  assert.deepEqual(withSpeakers.segments, segments);
  assert.equal(withSpeakers.durationSeconds, 120);
});

test("Sarvam sends the saved output mode with file and chat microphone requests", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-sarvam-mode-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.getState().setSarvamMode("verbatim", "upload");
  const config = {
    ...byokConfig(),
    cloudTranscriptionProvider: "sarvam",
    cloudTranscriptionModel: "saaras:v4",
    getApiKey: () => assert.fail("main owns the Sarvam key"),
  };
  const requests = [];
  window.electronAPI.transcribeAudioFileByok = async (options) => {
    requests.push(options);
    return { success: true, text: "Hello" };
  };
  useSettingsStore.getState().setSarvamMode("translit");
  await transcribeFile("/tmp/upload.wav", config, false, { timestamps: true });
  await transcribeFile("/tmp/chat.wav", config, false, { purpose: "dictation" });
  assert.deepEqual(
    requests.map(({ sarvamMode }) => sarvamMode),
    ["verbatim", "translit"]
  );
});

test("Sarvam keeps the starting output mode and credential generation throughout an upload queue", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-queue-sarvam-mode-",
    mockModules: { "/lib/auth": "export const withSessionRefresh = (fn) => fn();" },
  });
  const { addFiles, processBatchQueue, useBatchQueueStore } = await vite.ssrLoadModule(
    "/stores/batchQueueStore.ts"
  );
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.getState().setSarvamMode("verbatim", "upload");
  let currentGeneration = 0;
  const snapshotGeneration = t.mock.fn(async () => currentGeneration);
  snapshotGeneration.mock.mockImplementationOnce(async () => {
    throw new Error("Credential lookup interrupted");
  });
  window.electronAPI.getSarvamKeyGeneration = snapshotGeneration;
  const requests = [];
  window.electronAPI.transcribeAudioFileByok = async ({ sarvamMode, sarvamKeyGeneration }) => {
    requests.push([sarvamMode, sarvamKeyGeneration]);
    if (sarvamKeyGeneration !== currentGeneration) {
      return { success: false, error: "Key changed", code: "PROVIDER_CREDENTIAL_CHANGED" };
    }
    currentGeneration = 1;
    useSettingsStore.getState().setSarvamMode("translate", "upload");
    return { success: true, text: "Hello" };
  };
  window.electronAPI.saveNote = async () => ({ success: true, note: { id: 42 } });
  addFiles(
    ["one.wav", "two.wav", "three.wav"].map((name) => ({
      name,
      path: `/tmp/${name}`,
      sizeBytes: 1,
    }))
  );
  const startQueue = () =>
    new Promise((resolve) => {
      const unsubscribe = useBatchQueueStore.subscribe(({ isProcessing }) => {
        if (!isProcessing) {
          unsubscribe();
          resolve();
        }
      });
      processBatchQueue(
        {
          folderId: null,
          transcription: {
            ...byokConfig(),
            cloudTranscriptionProvider: "sarvam",
            cloudTranscriptionModel: "saaras:v4",
            getApiKey: () => assert.fail("main owns the queue's Sarvam key"),
          },
        },
        { enabled: false, localModelsReady: false, numSpeakers: null }
      );
    });
  await startQueue();
  const statuses = () => useBatchQueueStore.getState().queue.map(({ status }) => status);
  assert.deepEqual(statuses(), ["error", "queued", "queued"]);
  assert.equal(requests.length, 0);
  await startQueue();
  assert.equal(snapshotGeneration.mock.callCount(), 2);
  assert.deepEqual(requests, [
    ["verbatim", 0],
    ["verbatim", 0],
  ]);
  assert.deepEqual(statuses(), ["done", "error", "queued"]);
  await startQueue();
  assert.deepEqual(requests.slice(2), [
    ["translate", 1],
    ["translate", 1],
  ]);
  assert.ok(useBatchQueueStore.getState().queue.every(({ status }) => status === "done"));
});

// Local diarization over a provider that returned timed segments: each keeps
// its own timing and takes the diarizer speaker it overlaps most, instead of
// the merge's text-proportional turns.
test("local diarization labels the provider's timed segments by overlap", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-timestamps-diarize-test-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { transcribeFileWithSpeakers } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  window.electronAPI.transcribeAudioFileByok = async () => ({
    success: true,
    text: "Hello. Reply. Gap.",
    segments: [
      { text: "Hello.", start: 0, end: 4 },
      { text: "Reply.", start: 5, end: 9 },
      { text: "Gap.", start: 20, end: 21 },
    ],
  });
  let mergeDuration = null;
  window.electronAPI.diarizeAudioFile = async () => ({
    success: true,
    durationSeconds: 30,
    segments: [
      { start: 0, end: 4.5, speaker: "speaker_1" },
      { start: 4.5, end: 10, speaker: "speaker_0" },
      { start: 18, end: 19, speaker: "speaker_1" },
    ],
  });
  window.electronAPI.mergeSpeakerText = async (_segments, _text, duration) => {
    mergeDuration = duration;
    return {
      success: true,
      text: "[Speaker 1] 0:00 - 0:30\nHello. Reply. Gap.",
      segments: [{ speaker: "speaker_1", text: "Hello. Reply. Gap.", start: 0, end: 30 }],
    };
  };

  // Groq returns timed segments and has no diarization of its own.
  const result = await transcribeFileWithSpeakers(
    "/tmp/audio.webm",
    {
      ...byokConfig(),
      cloudTranscriptionProvider: "groq",
      cloudTranscriptionModel: "whisper-large-v3",
    },
    { enabled: true, localModelsReady: true, numSpeakers: null },
    null,
    { timestamps: true }
  );

  assert.equal(mergeDuration, 30, "the merge gets the diarizer's measured duration");
  assert.deepEqual(result.segments, [
    { text: "Hello.", start: 0, end: 4, speaker: "speaker_1" },
    { text: "Reply.", start: 5, end: 9, speaker: "speaker_0" },
    { text: "Gap.", start: 20, end: 21, speaker: "speaker_1" },
  ]);
});
