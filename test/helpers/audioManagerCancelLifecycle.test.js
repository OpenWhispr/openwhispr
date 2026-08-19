const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");

async function loadManagerClass(t) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-cancel-lifecycle-test-",
    settingsKey: "__cancelLifecycleSettings",
    settings: {
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
      cloudTranscriptionMode: "byok",
      isSignedIn: false,
    },
  });
  return AudioManager;
}

function createManager(AudioManager, transcription) {
  const calls = { errors: 0, saved: 0, noAudio: 0, completed: 0, states: [] };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isProcessing: true,
    _localSpeechGateState: null,
    _streamingStopPromise: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    lastAudioBlob: {},
    processWithLocalWhisper: () => transcription.promise,
    onStateChange: (state) => calls.states.push(state.isProcessing ? "processing" : "idle"),
    onNoAudio: () => calls.noAudio++,
    onError: () => calls.errors++,
    onTranscriptionComplete: () => calls.completed++,
    saveFailedTranscription: () => calls.saved++,
  });
  // The real implementation also aborts ReasoningService/IPC work; the test
  // only needs the generation bump that marks the pipeline cancelled.
  manager._requestStreamingCancellation = () => {
    manager._streamingCancellationGeneration += 1;
  };
  return { manager, calls };
}

test("a user cancel during batch transcription is not an error and saves nothing", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const transcription = deferred();
  const { manager, calls } = createManager(AudioManager, transcription);

  const run = manager.processAudio(new Blob(["audio"], { type: "audio/webm" }), {});
  assert.equal(manager.cancelProcessing(), true);
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  // The aborted request rejects after the cancel landed.
  const rejection = Promise.reject(abort);
  rejection.catch(() => {});
  transcription.resolve(rejection);
  await run;

  assert.equal(calls.errors, 0, "cancel must not surface a Transcription Error");
  assert.equal(calls.saved, 0, "cancel must not write a failed-transcription row");
  assert.equal(calls.completed, 0);
  assert.deepEqual(calls.states, ["idle"]);
});

test("a directive banked after the pipeline was cancelled is dropped", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createManager(AudioManager, deferred());
  manager.cancelProcessing();
  manager._bankAssistantDirective("late command", {}, null);
  assert.equal(manager.pendingAssistantConversation, null);
});
