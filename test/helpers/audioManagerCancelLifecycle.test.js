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

// Regression for a leak the reset above must close: _processingCancelled is a
// single instance flag, not per-request. A cancelled BATCH pipeline leaves it
// true; only processAudio()'s own entry resets it back to false. A STREAMING
// session's no-speech fallback calls processWithOpenWhisprCloud directly
// (never through processAudio), so without a matching reset at
// _finalizeStreamingRecording's entry, a genuine (non-abort) cloud-reasoning
// failure in that fallback would have its recordCleanupFailure call silently
// skipped by the stale flag — dropping a real "Cleanup Failed" toast
// (src/stores/cleanupFailureStore.ts -> CleanupFailureToastListener.tsx) that
// has nothing to do with the earlier, unrelated cancel.
async function loadCancelGuardManagerClass(t) {
  const { AudioManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-leak-test-",
    settingsKey: "__streamingLeakSettings",
    settings: {
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      isSignedIn: true,
      preferredLanguage: "auto",
      cleanupCloudMode: "openwhispr",
      useCleanupModel: true,
      customPrompts: {},
    },
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__streamingLeakSettings;
        export const getEffectiveCleanupModel = () => null;
        export const selectResolvedLLMConfig = () => ({ model: null, provider: null });
        export const isCloudCleanupMode = () => true;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      // The real store: capturing recordCleanupFailure is the whole point of
      // the streaming-fallback-leak test below, so the mock just makes its
      // calls observable.
      "/stores/cleanupFailureStore": `
        export const recordCleanupFailure = (message) => {
          globalThis.__streamingLeakCleanupFailureCalls.push(message);
        };
      `,
      // processWithOpenWhisprCloud's "agent" route walks through
      // resolveReasoningRoute -> dictationAgentPrompt -> resolvePrompt, which
      // reads the real useSettingsStore zustand store for custom prompts.
      // Mocking /config/prompts (as the real ReasoningService flow does in
      // production) sidesteps that store entirely, matching the established
      // pattern in audioManagerWakeWordLanguage.test.js.
      "/config/prompts": `
        export const resolvePrompt = () => "agent prompt";
        export const appendScreenContextSuffix = (prompt) => prompt;
      `,
      "/dictationAgentInference": `
        export const resolveDictationAgentInference = () => ({
          reachable: false,
          model: "",
          displayProvider: "none",
          config: {},
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
    },
  });
  const originalNavigator = globalThis.navigator;
  t.after(() => {
    delete globalThis.__streamingLeakCleanupFailureCalls;
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { ...originalNavigator, onLine: true },
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: window.localStorage,
    writable: true,
    configurable: true,
  });
  // The harness's window stub has no EventTarget surface; the batch-fallback
  // success path fires a plain usage-changed notification off it.
  window.dispatchEvent = () => {};
  return { AudioManager, window };
}

function createStreamingLeakManager(AudioManager) {
  const completions = [];
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    isStreaming: true,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    // 5s in the past so durationSeconds > 2 and the no-speech fallback runs.
    recordingStartTime: Date.now() - 5000,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 1,
    _activeStreamingSessionId: 1,
    _streamingMicSwapPromise: null,
    streamingFinalText: "",
    streamingPartialText: "",
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
    translationRequested: false,
    voiceAgentRequested: false,
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => ({
      size: 2048,
      type: "audio/webm",
      arrayBuffer: async () => new ArrayBuffer(8),
    }),
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      finalize() {},
      async stop() {
        return { success: true };
      },
    }),
    getStreamingProviderName: () => "openai",
    shouldUseStreaming: () => false,
    isRecordingAllowedByPolicy: () => true,
    // Real processWithOpenWhisprCloud runs; these three would otherwise need
    // more settings/state than this scenario cares about.
    isDictionaryEcho: () => false,
    getWhisperPrompt: () => null,
    finalizeChineseScript: async (text) => text,
    onStateChange: () => {},
    onTranscriptionComplete: (result) => completions.push(result),
  });
  return { manager, completions };
}

test(
  "a cancelled batch pipeline does not swallow a real cleanup failure in a later streaming fallback",
  async (t) => {
    const { AudioManager, window } = await loadCancelGuardManagerClass(t);
    const { manager, completions } = createStreamingLeakManager(AudioManager);
    globalThis.__streamingLeakCleanupFailureCalls = [];
    window.electronAPI.cloudTranscribe = async () => ({
      success: true,
      text: "the raw transcript",
    });
    window.electronAPI.cloudReason = async () => ({
      success: false,
      error: "genuine cloud reasoning failure",
      code: "SERVER_ERROR",
    });

    // Simulate the leak precondition: an earlier BATCH pipeline was
    // cancelled and left the instance-level flag set. Nothing about this
    // brand-new streaming session should inherit that.
    manager._processingCancelled = true;

    assert.equal(await manager.stopStreamingRecording(), true);

    assert.deepEqual(
      globalThis.__streamingLeakCleanupFailureCalls,
      ["genuine cloud reasoning failure"],
      "a genuine cloud-reasoning failure in the streaming fallback must still be recorded"
    );
    assert.equal(completions.length, 1);
    assert.equal(completions[0].text, "the raw transcript");
  }
);

// Finding 2 (round-1 review override): processWithOpenWhisprCloud's catch
// gates _notifyAgentReasoningFailed() too, not just the logger/cleanup-store
// calls the brief named. Without that, a cancelled voice-agent command whose
// cloud reasoning also happens to fail would still pop an "Agent Unavailable"
// toast via onError({ code: "AGENT_REASONING_FAILED" }) — the useAudioRecording
// cancel guard only filters TRANSCRIPTION_CANCELLED/REASON_CANCELLED, so that
// toast would reach the user, directly contradicting this task's goal.
test(
  "a cancelled voice-agent command's cloud reasoning failure notifies nothing",
  async (t) => {
    const { AudioManager, window } = await loadCancelGuardManagerClass(t);
    const errors = [];
    const manager = Object.assign(Object.create(AudioManager.prototype), {
      voiceAgentRequested: true,
      translationRequested: false,
      isDictionaryEcho: () => false,
      getWhisperPrompt: () => null,
      finalizeChineseScript: async (text) => text,
      processAgentCommand: async () => {
        throw new Error("agent boom");
      },
      onError: (error) => errors.push(error),
    });
    window.electronAPI.cloudTranscribe = async () => ({
      success: true,
      text: "the raw transcript",
    });

    // Simulate the leak precondition again, this time on the agent route.
    manager._processingCancelled = true;

    const result = await manager.processWithOpenWhisprCloud({
      size: 1024,
      type: "audio/webm",
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    assert.equal(result.text, "the raw transcript", "the raw transcript is still returned");
    assert.deepEqual(errors, [], "a cancelled agent command must notify nothing, not even Agent Unavailable");
  }
);
