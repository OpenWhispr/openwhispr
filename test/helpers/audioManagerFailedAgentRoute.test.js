const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const TRANSCRIPT = "Nova, this is a long note about the quarterly plan.";

// Only the STT HTTP response and the OS selection capture are stubbed. The real
// processAudio -> processWithOpenAIAPI -> processTranscription -> agent route ->
// processAgentCommand -> pipeline catch -> saveFailedTranscription chain runs.
async function runAgentDictation(t, sttResponse) {
  const originalContext = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    decodeAudioData() {
      const samples = new Float32Array(8);
      return Promise.resolve({
        sampleRate: 16000,
        numberOfChannels: 1,
        getChannelData: () => samples,
      });
    }
  };
  t.after(() => {
    if (originalContext === undefined) delete globalThis.OfflineAudioContext;
    else globalThis.OfflineAudioContext = originalContext;
  });

  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-failed-agent-route-test-",
    settingsKey: "__failedAgentRouteSettings",
    settings: {
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
      cloudTranscriptionModel: "whisper-1",
      allowLocalFallback: false,
      dataRetentionEnabled: true,
      audioRetentionDays: 0,
      useDictationAgent: true,
      dictationAgentMode: "local",
      dictationAgentModel: "local-model",
    },
    mockModules: {
      "/services/SyncService.js": "export const syncService = { debouncedPush() {} };",
      "/services/ReasoningService":
        "export default class ReasoningService { static cancelAllRequests() {} static async isAvailable() { return true; } }",
      "/config/prompts": "export const resolvePrompt = () => 'agent prompt';",
    },
  });
  window.localStorage.setItem("agentName", "Nova");

  const saved = [];
  const errors = [];
  window.electronAPI = {
    // The OS cannot verify the selection: neither "selected" nor caret/standalone.
    captureSelectedText: async () => ({ status: "error" }),
    saveTranscription: async (...args) => {
      saved.push(args);
      return { id: 1 };
    },
  };
  t.mock.method(globalThis, "fetch", async () => sttResponse());

  const audio = new Blob(["synthetic audio"], { type: "audio/webm" });
  const manager = createManager({
    isProcessing: true,
    lastAudioBlob: audio,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _localSpeechGateState: null,
    getEffectiveSttLanguage: () => "auto",
    getTranscriptionModel: () => "whisper-1",
    getAPIKey: async () => "test-key",
    getTranscriptionEndpoint: () => "https://stt.example.com/v1/audio/transcriptions",
    getWhisperPrompt: () => null,
    isDictionaryEcho: () => false,
    onStateChange() {},
    onError: (error) => errors.push(error),
  });

  await manager.processAudio(audio);

  return { saved, errors };
}

test("a transcript that succeeded is not lost when the agent selection edit fails", async (t) => {
  const { saved, errors } = await runAgentDictation(
    t,
    () => new Response(JSON.stringify({ text: TRANSCRIPT }), { status: 200 })
  );

  assert.equal(errors[0]?.code, "SELECTION_EDIT_CAPTURE_FAILED", "the edit failure is reported");
  assert.equal(saved.length, 1, "one history entry is saved");
  const [text, rawText, options] = saved[0];
  assert.equal(text, TRANSCRIPT, "the transcribed text is kept in the saved entry");
  assert.equal(rawText, TRANSCRIPT, "the transcribed text is kept as the raw transcript");
  assert.equal(options.status, "failed");
  assert.equal(options.errorCode, "SELECTION_EDIT_CAPTURE_FAILED");
});

test("a failure before any transcript exists still saves empty text", async (t) => {
  const { saved, errors } = await runAgentDictation(
    t,
    () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
  );

  assert.ok(errors.length > 0, "the transcription failure is reported");
  assert.equal(saved.length, 1, "one history entry is saved");
  const [text, rawText, options] = saved[0];
  assert.equal(text, "");
  assert.equal(rawText, null);
  assert.equal(options.status, "failed");
});
