const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const LOCAL_WHISPER_SETTINGS = {
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  cloudTranscriptionMode: "byok",
  isSignedIn: false,
};

async function loadManagerClass(t, settings = LOCAL_WHISPER_SETTINGS) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-no-audio-lifecycle-test-",
    settingsKey: "__noAudioLifecycleSettings",
    settings,
  });
  return AudioManager;
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
    processWithOpenWhisprCloud: async () => {
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
  const AudioManager = await loadManagerClass(t);
  const { manager, order, saved } = createManager(AudioManager, new Error("No audio detected"));

  await manager.processAudio({ size: 256, type: "audio/webm" });

  assert.equal(manager.isProcessing, false);
  assert.deepEqual(order, ["idle", "no-audio"]);
  assert.deepEqual(saved, []);
});

test("dictionary-echo silence keeps the recording but shares the settled outcome", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { DICTIONARY_ECHO_CODE } = await import("../../src/utils/dictionaryEchoFilter.js");
  const failure = new Error("No audio detected");
  failure.code = DICTIONARY_ECHO_CODE;
  const { manager, order, saved } = createManager(AudioManager, failure);

  await manager.processAudio({ size: 256, type: "audio/webm" });

  assert.deepEqual(order, ["idle", "no-audio"]);
  assert.deepEqual(saved, [{ message: "No audio detected", code: DICTIONARY_ECHO_CODE }]);
});

test("Cloud finding no speech is the no-audio outcome and keeps the recording", async (t) => {
  const AudioManager = await loadManagerClass(t, {
    useLocalWhisper: false,
    cloudTranscriptionMode: "openwhispr",
    isSignedIn: true,
  });
  // cloud-transcribe's shape for the API's 422 (ipcHandlers.js).
  const failure = Object.assign(new Error("No speech detected in audio"), {
    code: "NO_SPEECH_DETECTED",
  });
  const { manager, order, saved } = createManager(AudioManager, failure);

  await manager.processAudio({ size: 256, type: "audio/webm" });

  assert.deepEqual(order, ["idle", "no-audio"]);
  assert.deepEqual(saved, [{ message: "No speech detected in audio", code: "NO_SPEECH_DETECTED" }]);
});
