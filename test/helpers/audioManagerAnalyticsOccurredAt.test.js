const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager: loadAudioManagerHarness } = require("./harness/audioManager");

// The time a dictation happened travels with it: the cloud request carries it
// so server-side analytics record the real occurrence, and the local analytics
// event saved afterwards reuses the same value.
async function loadAudioManager(t) {
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
  });

  const { window, setSettings, createManager } = await loadAudioManagerHarness(t, {
    cachePrefix: "openwhispr-analytics-occurred-at-",
    settingsKey: "__analyticsOccurredAtSettings",
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__analyticsOccurredAtSettings;
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
    },
  });

  return {
    window,
    setSettings,
    createManager: () =>
      createManager({
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
