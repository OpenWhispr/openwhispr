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

test("Prisma uploads pin the account and key and pass the speaker count to Batch", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-gnani-upload-owner-",
    mockModules: { "/lib/auth": "export const withSessionRefresh = (fn) => fn();" },
  });
  const { snapshotGnaniUpload, transcribeFileWithSpeakers } = await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ accountId: "alice" });
  const owner = { accountId: "alice", authGeneration: 4 };
  window.electronAPI.getGnaniKeyGeneration = async () => 8;
  window.electronAPI.getNoteWriteGuard = async () => owner;
  const cfg = await snapshotGnaniUpload({
    ...byokConfig(),
    cloudTranscriptionProvider: "gnani",
    cloudTranscriptionModel: "prisma-v2.5",
    getApiKey: () => assert.fail("Gnani audio requests resolve the saved secret in main"),
  });
  let calls = 0;
  window.electronAPI.transcribeAudioFileByok = async (options) => {
    calls++;
    assert.equal(options.apiKey, "");
    assert.equal(options.model, "prisma-v2.5");
    assert.equal(options.gnaniKeyGeneration, 8);
    assert.deepEqual(options.gnaniOwner, owner);
    assert.equal(options.numSpeakers, 2);
    assert.equal(options.diarize, true);
    return { success: true, text: "Hello", diarized: true, durationSeconds: 33 };
  };
  const speakers = { enabled: true, localModelsReady: false, numSpeakers: 2 };
  const result = await transcribeFileWithSpeakers("/tmp/meeting.wav", cfg, speakers);
  assert.equal(result.durationSeconds, 33);
  usePolicyStore.setState({ accountId: "bob" });
  const stale = await transcribeFileWithSpeakers("/tmp/meeting.wav", cfg, speakers);
  assert.equal(stale.code, "AUTH_CONTEXT_CHANGED");
  assert.equal(calls, 1);
});

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
