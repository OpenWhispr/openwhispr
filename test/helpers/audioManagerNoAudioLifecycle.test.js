const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadAudioManager(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-no-audio-lifecycle-test-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => ({
          useLocalWhisper: true,
          localTranscriptionProvider: "whisper",
          whisperModel: "base",
          cloudTranscriptionMode: "byok",
          isSignedIn: false,
        });
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  return (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
}

function createManager(AudioManager, failure) {
  const order = [];
  const saved = [];
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isProcessing: true,
    _localSpeechGateState: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    lastAudioBlob: {},
    processWithLocalWhisper: async () => {
      throw failure;
    },
    onStateChange: (state) => order.push(state.isProcessing ? "processing" : "idle"),
    onNoAudio: () => order.push("no-audio"),
    onError: () => order.push("error"),
    saveFailedTranscription: (message, code) => saved.push({ message, code }),
  });
  return { manager, order, saved };
}

test("local silence becomes one no-audio outcome after processing is idle", async (t) => {
  const AudioManager = await loadAudioManager(t);
  const { manager, order, saved } = createManager(AudioManager, new Error("No audio detected"));

  await manager.processAudio({ size: 256, type: "audio/webm" });

  assert.equal(manager.isProcessing, false);
  assert.deepEqual(order, ["idle", "no-audio"]);
  assert.deepEqual(saved, []);
});

test("dictionary-echo silence keeps the recording but shares the settled outcome", async (t) => {
  const AudioManager = await loadAudioManager(t);
  const { DICTIONARY_ECHO_CODE } = await import("../../src/utils/dictionaryEchoFilter.js");
  const failure = new Error("No audio detected");
  failure.code = DICTIONARY_ECHO_CODE;
  const { manager, order, saved } = createManager(AudioManager, failure);

  await manager.processAudio({ size: 256, type: "audio/webm" });

  assert.deepEqual(order, ["idle", "no-audio"]);
  assert.deepEqual(saved, [{ message: "No audio detected", code: DICTIONARY_ECHO_CODE }]);
});
