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
