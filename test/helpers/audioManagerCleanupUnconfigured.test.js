const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const inferenceMocks = {
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
};

test("cleanup on with no model warns once, then again after the setup is fixed", async (t) => {
  const { createManager, setSettings } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-unconfigured-",
    settingsKey: "__audioCleanupUnconfiguredSettings",
    settings: {
      useCleanupModel: true,
      cleanupMode: "providers",
      cleanupProvider: "",
      useDictationAgent: false,
      useDictationTranslation: false,
      preferredLanguage: "en",
    },
    mockModules: inferenceMocks,
  });

  const manager = createManager({
    voiceAgentRequested: false,
    translationRequested: false,
    pendingCleanupFailure: null,
  });

  assert.equal(await manager.processTranscriptionCore("hello there", "local"), "hello there");
  const first = manager._takePendingResultExtras();
  assert.equal(first.cleanupFailure.messageKey, "hooks.audioRecording.cleanupUnconfigured");
  assert.equal(first.cleanupFailure.settingsTarget, "llms");

  assert.equal(await manager.processTranscriptionCore("hello again", "local"), "hello again");
  assert.deepEqual(manager._takePendingResultExtras(), {});

  setSettings({
    useCleanupModel: false,
    cleanupMode: "providers",
    cleanupProvider: "",
    useDictationAgent: false,
    useDictationTranslation: false,
    preferredLanguage: "en",
  });
  assert.equal(await manager.processTranscriptionCore("cleanup off", "local"), "cleanup off");
  assert.deepEqual(manager._takePendingResultExtras(), {});

  setSettings({
    useCleanupModel: true,
    cleanupMode: "providers",
    cleanupProvider: "",
    useDictationAgent: false,
    useDictationTranslation: false,
    preferredLanguage: "en",
  });
  assert.equal(await manager.processTranscriptionCore("broken again", "local"), "broken again");
  assert.equal(
    manager._takePendingResultExtras().cleanupFailure.messageKey,
    "hooks.audioRecording.cleanupUnconfigured"
  );
});
