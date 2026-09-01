const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("cleanup failure details ride the raw result instead of notifying before paste", async (t) => {
  globalThis.__cleanupFallbackImmediateNotifications = [];
  t.after(() => delete globalThis.__cleanupFallbackImmediateNotifications);

  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-fallback-",
    settingsKey: "__audioCleanupFallbackSettings",
    settings: {
      useCleanupModel: true,
      cleanupProvider: "bedrock",
      cleanupMode: "enterprise",
      cleanupDisableThinking: true,
      useDictationAgent: false,
      useDictationTranslation: false,
      preferredLanguage: "en",
      enterpriseSetupMode: "manual",
    },
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__audioCleanupFallbackSettings;
        export const getEffectiveCleanupModel = () => "anthropic.claude-haiku";
        export const selectResolvedLLMConfig = () => ({
          mode: "enterprise",
          provider: "bedrock",
          model: "anthropic.claude-haiku"
        });
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
        export const useSettingsStore = { subscribe: () => () => {} };
      `,
      "/dictationAgentInference": `
        export const resolveDictationAgentInference = () => ({
          reachable: false, model: "", displayProvider: "none", config: {}
        });
        export const resolveDictationAgentVisionInference = () => ({
          active: false, model: "", config: {}
        });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: false, model: "", displayProvider: "none", config: {}
        });
      `,
      "/stores/cleanupFailureStore": `
        export const recordCleanupFailure = (failure) => {
          globalThis.__cleanupFallbackImmediateNotifications.push(failure);
        };
      `,
    },
  });

  const technicalDetails = {
    status: 503,
    exceptionType: "ServiceUnavailableException",
    requestId: "request-503",
    underlyingError: "AWS overloaded",
  };
  const failure = Object.assign(
    new Error(
      "AWS Bedrock is temporarily unavailable due to high demand. This is an AWS service issue, not an OpenWhispr outage. Please try again in a few minutes."
    ),
    { technicalDetails }
  );
  const manager = createManager({
    voiceAgentRequested: false,
    translationRequested: false,
    pendingCleanupFailure: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    isReasoningAvailable: async () => true,
    processWithReasoningModel: async () => {
      throw failure;
    },
  });

  const text = await manager.processTranscriptionCore("original dictation", "local");

  assert.equal(text, "original dictation");
  assert.deepEqual(globalThis.__cleanupFallbackImmediateNotifications, []);
  assert.deepEqual(manager._takePendingResultExtras(), {
    cleanupFailure: { message: failure.message, technicalDetails },
  });
  assert.deepEqual(manager._takePendingResultExtras(), {});
});
