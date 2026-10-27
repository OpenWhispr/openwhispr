const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const TRANSCRIPT = "Nova, this is a long note about the quarterly plan.";

// The STT response (HTTP for BYOK, cloudTranscribe for Cloud) and the OS
// selection capture are stubbed, along with the harness's settings, service
// and endpoint seams. The real processAudio -> provider -> agent route ->
// processAgentCommand -> pipeline catch -> saveFailedTranscription chain runs.
async function runAgentDictation(
  t,
  { sttResponse, settings = {}, electronAPI = {}, onManager = () => {} }
) {
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
      agentName: "Nova",
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
      ...settings,
    },
    mockModules: {
      "/services/SyncService.js": "export const syncService = { debouncedPush() {} };",
      "/services/ReasoningService":
        "export default class ReasoningService { static cancelAllRequests() {} static async isAvailable() { return true; } }",
      "/config/prompts": "export const resolvePrompt = () => 'agent prompt';",
    },
  });

  const saved = [];
  const errors = [];
  window.electronAPI = {
    // The OS cannot verify the selection: neither "selected" nor caret/standalone.
    captureSelectedText: async () => ({ status: "error" }),
    saveTranscription: async (...args) => {
      saved.push(args);
      return { id: 1 };
    },
    ...electronAPI,
  };
  if (sttResponse) t.mock.method(globalThis, "fetch", async () => sttResponse());

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
  onManager(manager);

  await manager.processAudio(audio);

  return { saved, errors };
}

const sttOk = () => new Response(JSON.stringify({ text: TRANSCRIPT }), { status: 200 });

test("a transcript that succeeded is not lost when the agent selection edit fails", async (t) => {
  const { saved, errors } = await runAgentDictation(t, { sttResponse: sttOk });

  assert.equal(errors[0]?.code, "SELECTION_EDIT_CAPTURE_FAILED", "the edit failure is reported");
  assert.equal(errors[0]?.transcript, TRANSCRIPT, "the failure pill offers the transcript");
  assert.equal(saved.length, 1, "one history entry is saved");
  const [text, rawText, options] = saved[0];
  assert.equal(text, TRANSCRIPT, "the transcribed text is kept in the saved entry");
  assert.equal(rawText, TRANSCRIPT, "the transcribed text is kept as the raw transcript");
  assert.equal(options.status, "failed");
  assert.equal(options.errorCode, "SELECTION_EDIT_CAPTURE_FAILED");
});

test("an OpenWhispr Cloud transcript is kept under Cloud's client id when the edit fails", async (t) => {
  const onLine = Object.getOwnPropertyDescriptor(globalThis.navigator, "onLine");
  Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
  t.after(() => {
    if (onLine) Object.defineProperty(globalThis.navigator, "onLine", onLine);
    else delete globalThis.navigator.onLine;
  });

  const { saved, errors } = await runAgentDictation(t, {
    settings: { cloudTranscriptionMode: "openwhispr", isSignedIn: true },
    electronAPI: {
      cloudTranscribe: async () => ({
        success: true,
        text: TRANSCRIPT,
        clientTranscriptionId: "cloud-client-id",
      }),
    },
  });

  assert.equal(errors[0]?.code, "SELECTION_EDIT_CAPTURE_FAILED");
  assert.equal(errors[0]?.transcript, TRANSCRIPT);
  assert.equal(saved.length, 1);
  const [text, rawText, options] = saved[0];
  assert.equal(text, TRANSCRIPT);
  assert.equal(rawText, TRANSCRIPT);
  assert.equal(options.status, "failed");
  // Cloud already holds this transcription's row; a later retry syncs onto it.
  assert.equal(options.clientTranscriptionId, "cloud-client-id");
});

test("the kept transcript never serializes with the error", async (t) => {
  let thrown;
  await runAgentDictation(t, {
    sttResponse: sttOk,
    onManager(manager) {
      const processTranscription = manager.processTranscription.bind(manager);
      manager.processTranscription = async (...args) => {
        try {
          return await processTranscription(...args);
        } catch (error) {
          thrown = error;
          throw error;
        }
      };
    },
  });

  assert.equal(thrown?.transcript, TRANSCRIPT);
  // The logger spreads a top-level error and JSON-encodes nested ones.
  assert.equal(Object.keys(thrown).includes("transcript"), false);
  assert.doesNotMatch(JSON.stringify({ ...thrown, nested: { error: thrown } }), /quarterly plan/);
});

test("a dictation cancelled during the selection edit saves nothing", async (t) => {
  let manager;
  const { saved, errors } = await runAgentDictation(t, {
    sttResponse: sttOk,
    onManager: (created) => {
      manager = created;
    },
    electronAPI: {
      captureSelectedText: async () => {
        manager._processingCancellationGeneration += 1;
        return { status: "error" };
      },
    },
  });

  assert.equal(saved.length, 0);
  assert.equal(errors.length, 0);
});

test("a failure before any transcript exists still saves empty text", async (t) => {
  const { saved, errors } = await runAgentDictation(t, {
    sttResponse: () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }),
  });

  assert.equal(errors[0]?.code, "PROVIDER_UNAVAILABLE", "the STT failure is what is reported");
  assert.equal(errors[0]?.transcript, undefined);
  assert.equal(saved.length, 1, "one history entry is saved");
  const [text, rawText, options] = saved[0];
  assert.equal(text, "");
  assert.equal(rawText, null);
  assert.equal(options.status, "failed");
  assert.equal("clientTranscriptionId" in options, false);
});

test("only a selection edit failure carries the transcript out", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-failed-agent-route-test-",
    settingsKey: "__failedAgentRouteSettings",
    settings: {},
    mockModules: {
      "/services/SyncService.js": "export const syncService = { debouncedPush() {} };",
    },
  });
  const manager = createManager({});
  // A cached rejection (opencc-js failing to load) is one object shared by
  // every later dictation, so it must never pick up the first one's text.
  const shared = new Error("opencc-js failed to load");
  manager.processTranscriptionCore = async () => {
    throw shared;
  };
  await assert.rejects(manager.processTranscription(TRANSCRIPT, "openai"), shared);
  assert.equal(shared.transcript, undefined);

  const editFailure = Object.assign(new Error("edit failed"), { selectionEditFatal: true });
  manager.processTranscriptionCore = async () => {
    throw editFailure;
  };
  await assert.rejects(manager.processTranscription(`  ${TRANSCRIPT} `, "openai"), editFailure);
  assert.equal(editFailure.transcript, TRANSCRIPT);
});
