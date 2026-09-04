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

test("cloud transcription returns the occurrence time sent with analytics", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t);
  const analyticsOccurredAt = "2026-09-02T14:00:00.000Z";
  const audioBlob = {
    type: "audio/webm",
    size: 1024,
    arrayBuffer: async () => new ArrayBuffer(8),
  };
  let requestOptions;

  setSettings({
    preferredLanguage: "auto",
    useCleanupModel: false,
    customDictionary: [],
    snippets: [],
    isSignedIn: true,
    insightsSyncEnabled: true,
    dataRetentionEnabled: true,
  });
  window.electronAPI.cloudTranscribe = async (_audio, options) => {
    requestOptions = options;
    return {
      success: true,
      text: "same event",
      clientTranscriptionId: "event-1",
    };
  };

  const result = await createManager().processWithOpenWhisprCloud(audioBlob, {
    analyticsOccurredAt,
  });

  assert.equal(requestOptions.analyticsOccurredAt, analyticsOccurredAt);
  assert.equal(result.analyticsOccurredAt, analyticsOccurredAt);
});

test("local analytics save uses the propagated occurrence time", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t);
  const analyticsOccurredAt = "2026-09-02T14:00:00.000Z";
  let recordedEvent;

  setSettings({
    dataRetentionEnabled: true,
    audioRetentionDays: 0,
    customDictionary: [],
    snippets: [],
  });
  window.electronAPI.recordAnalyticsEvent = async (event) => {
    recordedEvent = event;
  };
  window.electronAPI.saveTranscription = async () => ({});

  await createManager().saveTranscription("same event", "same event", {
    clientTranscriptionId: "event-1",
    analyticsOccurredAt,
  });

  assert.equal(recordedEvent.occurredAt, analyticsOccurredAt);
});
