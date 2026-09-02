const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function localConfig() {
  return {
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
    transcriptionMode: "providers",
  };
}

async function loadFileTranscription(t) {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-diarization-warning-test-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { transcribeFileWithSpeakers } = await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  );
  window.electronAPI.transcribeAudioFile = async () => ({
    success: true,
    text: "Plain transcript",
  });
  return { window, transcribeFileWithSpeakers };
}

test("keeps the transcript and warns when local speaker identification fails", async (t) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.diarizeAudioFile = async () => ({
    success: false,
    error: "Speaker identification failed",
  });

  const result = await transcribeFileWithSpeakers(
    "/tmp/audio.wav",
    localConfig(),
    { enabled: true, localModelsReady: true, numSpeakers: null }
  );

  assert.equal(result.success, true);
  assert.equal(result.text, "Plain transcript");
  assert.equal(result.diarizationWarning, true);
});

test("keeps the transcript and warns when speaker labels cannot be merged", async (t) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.diarizeAudioFile = async () => ({
    success: true,
    segments: [{ speaker: "speaker_00", start: 0, end: 2 }],
  });
  window.electronAPI.mergeSpeakerText = async () => ({
    success: false,
    error: "Merge failed",
  });

  const result = await transcribeFileWithSpeakers(
    "/tmp/audio.wav",
    localConfig(),
    { enabled: true, localModelsReady: true, numSpeakers: null }
  );

  assert.equal(result.success, true);
  assert.equal(result.text, "Plain transcript");
  assert.equal(result.diarizationWarning, true);
});

test("does not warn when speaker labels are merged", async (t) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.diarizeAudioFile = async () => ({
    success: true,
    segments: [{ speaker: "speaker_00", start: 0, end: 2 }],
  });
  window.electronAPI.mergeSpeakerText = async () => ({
    success: true,
    text: "Speaker 1: Plain transcript",
  });

  const result = await transcribeFileWithSpeakers(
    "/tmp/audio.wav",
    localConfig(),
    { enabled: true, localModelsReady: true, numSpeakers: null }
  );

  assert.equal(result.text, "Speaker 1: Plain transcript");
  assert.equal(result.diarizationWarning, undefined);
});
