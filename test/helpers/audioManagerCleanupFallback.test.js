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
    {
      messageKey: "reasoning.enterprise.errors.bedrock.serviceUnavailable",
      action: "Run the command below in your terminal to re-authenticate:",
      actionKey: "reasoning.enterprise.errors.bedrock.actions.reauthenticate",
      copyCommand: "aws sso login --profile company-sso",
      technicalDetails,
    }
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
    cleanupFailure: {
      message: failure.message,
      messageKey: failure.messageKey,
      action: failure.action,
      actionKey: failure.actionKey,
      copyCommand: failure.copyCommand,
      technicalDetails,
    },
  });
  assert.deepEqual(manager._takePendingResultExtras(), {});
});

test("safePaste returns false when the preload reports that no text was pasted", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-paste-outcome-",
    settingsKey: "__audioCleanupPasteOutcomeSettings",
  });
  const manager = createManager({
    onError: () => assert.fail("a resolved no-op is not a paste error"),
  });
  window.electronAPI.pasteText = async () => ({ success: true, pasted: false });

  assert.equal(await manager.safePaste("onboarding transcript"), false);
});

test("safePaste returns true only when the preload reports a completed paste", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-paste-success-",
    settingsKey: "__audioCleanupPasteSuccessSettings",
  });
  const manager = createManager({
    onError: () => assert.fail("a completed paste must not report an error"),
  });
  window.electronAPI.pasteText = async () => ({ success: true, pasted: true });

  assert.equal(await manager.safePaste("completed transcript"), true);
});
