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
  const mod = await vite.ssrLoadModule("/services/fileTranscription.ts");
  window.electronAPI.transcribeAudioFile = async () => ({
    success: true,
    text: "Plain transcript",
  });
  return { window, ...mod };
}

test("keeps the transcript and warns when local speaker identification fails", async (t) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.diarizeAudioFile = async () => ({
    success: false,
    error: "Speaker identification failed",
  });

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

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

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

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

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(result.text, "Speaker 1: Plain transcript");
  assert.equal(result.diarizationWarning, undefined);
});

test("does not warn when speaker detection is off", async (t) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  let diarizeCalls = 0;
  window.electronAPI.diarizeAudioFile = async () => {
    diarizeCalls += 1;
    return { success: false };
  };

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: false,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(diarizeCalls, 0);
  assert.equal(result.diarizationWarning, undefined);
});

test("does not warn when the provider applied its own speaker labels", async (t) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.transcribeAudioFile = async () => ({
    success: true,
    text: "[Speaker 1] Hola",
    diarized: true,
  });

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(result.diarizationWarning, undefined);
});

test("keeps the transcript and warns when the merge throws", async (t) => {
  const { window, transcribeFileWithSpeakers } = await loadFileTranscription(t);
  window.electronAPI.diarizeAudioFile = async () => ({
    success: true,
    segments: [{ speaker: "speaker_00", start: 0, end: 2 }],
  });
  window.electronAPI.mergeSpeakerText = async () => {
    throw new Error("merge crashed");
  };

  const result = await transcribeFileWithSpeakers("/tmp/audio.wav", localConfig(), {
    enabled: true,
    localModelsReady: true,
    numSpeakers: null,
  });

  assert.equal(result.text, "Plain transcript");
  assert.equal(result.diarizationWarning, true);
});

test("fetches the local speaker models before a run that needs them", async (t) => {
  const { resolveDiarizationSettings } = await loadFileTranscription(t);
  let ensureCalls = 0;

  const settings = await resolveDiarizationSettings({
    enabled: true,
    modelsReady: false,
    numSpeakers: null,
    config: localConfig(),
    ensureModels: async () => {
      ensureCalls += 1;
      return true;
    },
  });

  assert.equal(ensureCalls, 1);
  assert.deepEqual(settings, { enabled: true, localModelsReady: true, numSpeakers: null });
});

test("does not fetch local models when the provider diarizes server-side", async (t) => {
  const { resolveDiarizationSettings } = await loadFileTranscription(t);
  let ensureCalls = 0;

  const settings = await resolveDiarizationSettings({
    enabled: true,
    modelsReady: false,
    numSpeakers: 2,
    config: { ...localConfig(), useLocalWhisper: false, cloudTranscriptionProvider: "openai" },
    ensureModels: async () => {
      ensureCalls += 1;
      return true;
    },
  });

  assert.equal(ensureCalls, 0);
  assert.deepEqual(settings, { enabled: true, localModelsReady: false, numSpeakers: 2 });
});

test("does not fetch local models when speaker detection is off", async (t) => {
  const { resolveDiarizationSettings } = await loadFileTranscription(t);
  let ensureCalls = 0;

  const settings = await resolveDiarizationSettings({
    enabled: false,
    modelsReady: false,
    numSpeakers: null,
    config: localConfig(),
    ensureModels: async () => {
      ensureCalls += 1;
      return true;
    },
  });

  assert.equal(ensureCalls, 0);
  assert.equal(settings.enabled, false);
});

test("reports models unavailable when the download fails", async (t) => {
  const { resolveDiarizationSettings } = await loadFileTranscription(t);

  const settings = await resolveDiarizationSettings({
    enabled: true,
    modelsReady: false,
    numSpeakers: null,
    config: localConfig(),
    ensureModels: async () => false,
  });

  assert.equal(settings.localModelsReady, false);
});
