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
