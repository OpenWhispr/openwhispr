const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadAudioManager(t) {
  const { window } = installBrowserGlobals(t, {
    initialStorage: { agentName: "Jarvis" },
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: window.localStorage,
    writable: true,
    configurable: true,
  });
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { ...originalNavigator, onLine: true },
    configurable: true,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
    delete globalThis.__wakeWordSettings;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-wake-language-test-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__wakeWordSettings;
        export const getEffectiveCleanupModel = () => "cleanup-model";
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
        export const selectResolvedLLMConfig = () => ({ model: "cleanup-model" });
      `,
      "/dictationAgentInference": `
        export const resolveDictationAgentInference = () => ({
          reachable: true,
          model: "agent-model",
          displayProvider: "test",
          config: { provider: "test" },
        });
        export const resolveDictationAgentVisionInference = () => ({
          active: false,
          model: "",
          config: {},
        });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: false,
          model: "",
          displayProvider: "none",
          config: {},
        });
      `,
      "/config/prompts": `
        export const resolvePrompt = () => "agent prompt";
        export const appendScreenContextSuffix = (prompt) => prompt;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return {
    window,
    setSettings: (settings) => {
      globalThis.__wakeWordSettings = settings;
    },
    createManager: () =>
      Object.assign(Object.create(AudioManager.prototype), {
        voiceAgentRequested: false,
        translationRequested: false,
        isDictionaryEcho: () => false,
        getWhisperPrompt: () => null,
        assertAgentAllowedByPolicy: () => {},
        processAgentCommand: async () => "agent output",
        processWithReasoningModel: async () => "cleanup output",
        finalizeChineseScript: async (text) => text,
      }),
    createBankingManager: () =>
      Object.assign(Object.create(AudioManager.prototype), {
        voiceAgentRequested: false,
        translationRequested: false,
        isProcessing: true,
        pendingAssistantConversation: null,
        pendingSelectionEdit: null,
        pendingCleanupFailure: null,
        selectionCapturePromise: null,
        isDictionaryEcho: () => false,
        getWhisperPrompt: () => null,
        assertAgentAllowedByPolicy: () => {},
        consumeAssistantSelectionContext: () => null,
        consumeSelectionCapture: async () => null,
        processWithReasoningModel: async () => "cleanup output",
        finalizeChineseScript: async (text) => text,
      }),
    createStreamingManager: (onTranscriptionComplete, transcript = "يا Max، لخّص هذه الملاحظة") =>
      Object.assign(Object.create(AudioManager.prototype), {
        voiceAgentRequested: false,
        translationRequested: false,
        isRecording: true,
        isProcessing: false,
        isStreaming: true,
        streamingStartInProgress: false,
        _streamingStartSettlementWaiters: [],
        stopRequestedDuringStreamingStart: false,
        recordingStartTime: Date.now(),
        _streamingStopPromise: null,
        _streamingStopMode: null,
        _streamingCancellationGeneration: 0,
        _activeTranscriptionAbortController: null,
        _streamingSessionGeneration: 1,
        _activeStreamingSessionId: 1,
        _streamingMicSwapPromise: null,
        streamingFinalText: transcript,
        streamingPartialText: "",
        streamingTextBump: null,
        streamingTextDebounce: null,
        streamingCleanupFns: [],
        streamingProcessor: null,
        streamingSource: null,
        streamingAnalyser: null,
        streamingAudioContext: null,
        streamingStream: null,
        streamingFallbackRecorder: null,
        streamingFallbackChunks: [],
        _streamingFallbackSegments: [],
        pendingAssistantConversation: null,
        pendingSelectionEdit: null,
        pendingCleanupFailure: null,
        assistantSelectionContext: null,
        selectionCapturePromise: null,
        micRecovery: { stop() {} },
        finishStreamingFallbackSegment: async () => null,
        mergeRecordedSegments: async () => null,
        getLargestRecordedSegment: () => null,
        awaitStreamingTextSettled: async () => {},
        getStreamingProvider: () => ({
          awaitsFinalTranscript: true,
          finalize() {},
          stop: async () => ({ success: true, model: "test-stream" }),
        }),
        getEffectiveSttLanguage: () => "auto",
        getStreamingProviderName: () => "test",
        shouldUseStreaming: () => false,
        assertAgentAllowedByPolicy: () => {},
        consumeAssistantSelectionContext: () => null,
        consumeSelectionCapture: async () => null,
        processWithReasoningModel: async () => "cleanup output",
        finalizeChineseScript: async (text) => text,
        onStateChange() {},
        onTranscriptionComplete,
      }),
  };
}

test("cloud auto-language routing uses detected speech before the UI language", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t);
  const audioBlob = {
    type: "audio/webm",
    size: 1024,
    arrayBuffer: async () => new ArrayBuffer(8),
  };
  const settings = {
    preferredLanguage: "auto",
    useCleanupModel: true,
    cleanupCloudMode: "byok",
    cleanupDisableThinking: false,
    customDictionary: [],
    snippets: [],
  };

  setSettings({ ...settings, uiLanguage: "it" });
  window.electronAPI.cloudTranscribe = async () => ({
    success: true,
    text: "and then ehi Jarvis said something",
    sttLanguage: "en",
  });
  const englishResult = await createManager().processWithOpenWhisprCloud(audioBlob);
  assert.equal(englishResult.text, "cleanup output");

  setSettings({ ...settings, uiLanguage: "en" });
  window.electronAPI.cloudTranscribe = async () => ({
    success: true,
    text: "stavo pensando ehi Jarvis scrivi una mail",
    sttLanguage: "it",
  });
  const italianResult = await createManager().processWithOpenWhisprCloud(audioBlob);
  assert.equal(italianResult.text, "agent output");
});

test("cloud auto-language stripping uses the same detected Arabic as routing", async (t) => {
  const { window, setSettings, createBankingManager } = await loadAudioManager(t);
  const audioBlob = {
    type: "audio/webm",
    size: 1024,
    arrayBuffer: async () => new ArrayBuffer(8),
  };
  setSettings({
    preferredLanguage: "auto",
    uiLanguage: "en",
    useCleanupModel: true,
    cleanupCloudMode: "byok",
    cleanupDisableThinking: false,
    customDictionary: [],
    snippets: [],
  });
  localStorage.setItem("agentName", "Max");
  window.electronAPI.cloudTranscribe = async () => ({
    success: true,
    text: "يا Max، لخّص هذه الملاحظة",
    sttLanguage: "ar",
  });

  const manager = createBankingManager();
  await manager.processWithOpenWhisprCloud(audioBlob);

  assert.equal(manager.pendingAssistantConversation?.transcript, "لخّص هذه الملاحظة");
});

test("generic auto-language routing infers Arabic before an English UI fallback", async (t) => {
  const { setSettings, createBankingManager } = await loadAudioManager(t);
  setSettings({
    preferredLanguage: "auto",
    uiLanguage: "en",
    useCleanupModel: true,
    cleanupCloudMode: "byok",
    cleanupDisableThinking: false,
    customDictionary: [],
    snippets: [],
  });
  localStorage.setItem("agentName", "Max");

  const manager = createBankingManager();
  manager.isReasoningAvailable = async () => true;
  await manager.processTranscriptionCore("يا Max، لخّص هذه الملاحظة", "local");

  assert.equal(manager.pendingAssistantConversation?.transcript, "لخّص هذه الملاحظة");
});

test("streaming auto-language routing detects and strips Arabic with an English UI", async (t) => {
  const { window, setSettings, createStreamingManager } = await loadAudioManager(t);
  setSettings({
    preferredLanguage: "auto",
    uiLanguage: "en",
    useCleanupModel: true,
    cleanupCloudMode: "byok",
    cleanupDisableThinking: false,
    customDictionary: [],
    snippets: [],
  });
  localStorage.removeItem("agentName");
  window.electronAPI.cloudStreamingUsage = async () => ({ success: true });
  window.dispatchEvent = () => true;
  const completions = [];

  const manager = createStreamingManager(
    (result) => completions.push(result),
    "يا OpenWhispr، لخّص هذه الملاحظة"
  );
  await manager.stopStreamingRecording();

  assert.equal(completions[0]?.assistantConversation?.transcript, "لخّص هذه الملاحظة");
});
