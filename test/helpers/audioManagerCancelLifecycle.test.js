const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");

async function loadManagerClass(t) {
  const { AudioManager, window } = await loadAudioManager(t, {
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
  return { AudioManager, window };
}

function createManager(AudioManager, transcription) {
  const calls = { errors: 0, saved: 0, noAudio: 0, completed: 0, states: [] };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isProcessing: true,
    _localSpeechGateState: null,
    _processingCancellationGeneration: 0,
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

function createBatchFinalizationManager(AudioManager, merge) {
  let processAudioCalls = 0;
  const mergedBlob = new Blob([new Uint8Array(512)], { type: "audio/webm" });
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _batchSegments: [],
    _receivedAudioData: true,
    _localSpeechGateState: null,
    _streamingCommitActive: false,
    recordingMimeType: "audio/webm",
    recordingStartTime: Date.now(),
    lastAudioBlob: null,
    micRecovery: { stop() {} },
    teardownSpeechGate() {},
    cleanupPreview: async () => null,
    shouldShowPreviewCleanupState: () => false,
    mergeRecordedSegments: () => merge.promise,
    getLargestRecordedSegment: () => null,
    processAudio: async () => {
      processAudioCalls += 1;
    },
    onStateChange() {},
  });
  manager._requestStreamingCancellation = () => {
    manager._streamingCancellationGeneration += 1;
  };
  return { manager, mergedBlob, getProcessAudioCalls: () => processAudioCalls };
}

test("cancelling while batch segments merge never starts transcription", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const merge = deferred();
  const { manager, mergedBlob, getProcessAudioCalls } = createBatchFinalizationManager(
    AudioManager,
    merge
  );

  const finalization = manager.finalizeBatchRecording(mergedBlob);
  assert.equal(manager.isProcessing, true);
  assert.equal(manager.cancelProcessing(), true);
  merge.resolve(mergedBlob);
  await finalization;

  assert.equal(getProcessAudioCalls(), 0);
  assert.equal(manager.lastAudioBlob, null);
});

test("a cancelled older pipeline cannot publish or clear a newer pipeline", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const firstTranscription = deferred();
  const secondTranscription = deferred();
  const completed = [];
  const firstBlob = new Blob(["first"], { type: "audio/webm" });
  const secondBlob = new Blob(["second"], { type: "audio/webm" });
  const { manager } = createManager(AudioManager, firstTranscription);
  manager.processWithLocalWhisper = (audioBlob) =>
    audioBlob === firstBlob ? firstTranscription.promise : secondTranscription.promise;
  manager.onTranscriptionComplete = (result) => completed.push(result.text);

  const firstRun = manager.processAudio(firstBlob);
  assert.equal(manager.cancelProcessing(), true);

  manager.isProcessing = true;
  const secondRun = manager.processAudio(secondBlob);
  firstTranscription.resolve({ success: true, text: "old", source: "local", timings: {} });
  await firstRun;

  assert.equal(manager.isProcessing, true, "the old pipeline must not clear the new busy state");
  assert.deepEqual(completed, [], "the old pipeline must not publish after cancellation");

  secondTranscription.resolve({ success: true, text: "new", source: "local", timings: {} });
  await secondRun;

  assert.equal(manager.isProcessing, false);
  assert.deepEqual(completed, ["new"]);
});

test("a cancelled current pipeline clears busy when its pending work settles", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const transcription = deferred();
  const { manager, calls } = createManager(AudioManager, transcription);
  // Streaming finalization keeps the lifecycle busy while provider/model work
  // is still settling instead of advertising an idle state prematurely.
  manager._streamingStopPromise = Promise.resolve(true);

  const run = manager.processAudio(new Blob(["audio"], { type: "audio/webm" }));
  assert.equal(manager.cancelProcessing(), true);
  assert.equal(manager.isProcessing, true, "cancel keeps busy until the owned work settles");

  transcription.resolve({ success: true, text: "stale", source: "local", timings: {} });
  await run;

  assert.equal(manager.isProcessing, false);
  assert.deepEqual(calls.states, ["idle"]);
  assert.equal(calls.completed, 0);
});

test("a user cancel during batch transcription is not an error and saves nothing", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
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
  const { AudioManager } = await loadManagerClass(t);
  const { manager } = createManager(AudioManager, deferred());
  manager.cancelProcessing();
  manager._bankAssistantDirective("late command", {}, null);
  assert.equal(manager.pendingAssistantConversation, null);
});

// Round-2 review finding: finalizeBatchRecording's earlier cleanupPreview()
// call (without dismiss:true) routes through the main process's
// stop-dictation-preview handler, which — whenever the live-preview toggle
// left a session active — calls windowManager.holdTranscriptionPreview(),
// NOT hideTranscriptionPreview(). That sends "preview-hold", which
// useLiveTranscriptPanel.js handles by deliberately keeping the panel open
// (phase "cleanup"/"final") so the user can see the settled text. Before this
// task, onError's unconditional hideDictationPreview() call was what closed
// that held panel on a failure. The cancel guard in processAudio's catch
// means onError never fires for a cancel, so without a dedicated teardown on
// the cancel path itself, a cancel during batch processing leaves the held
// panel on screen indefinitely. cancelProcessing() must dismiss it directly.
test("a cancel during batch processing dismisses the held live-transcript panel", async (t) => {
  const { AudioManager, window } = await loadManagerClass(t);
  const { manager } = createManager(AudioManager, deferred());
  const dismissCalls = [];
  window.electronAPI.dismissDictationPreview = () => {
    dismissCalls.push(true);
    return Promise.resolve({ success: true });
  };
  // hideDictationPreview must NOT be what this fix relies on — onError,
  // which used to own that call, no longer runs for a cancel at all.
  const hideCalls = [];
  window.electronAPI.hideDictationPreview = () => {
    hideCalls.push(true);
    return Promise.resolve({ success: true });
  };

  assert.equal(manager.cancelProcessing(), true);

  assert.equal(
    dismissCalls.length,
    1,
    "a cancel must dismiss the held preview panel, not leave it open"
  );
  assert.equal(hideCalls.length, 0, "the fix must not depend on onError's hideDictationPreview");
});

test("cancelling when nothing is processing dismisses nothing", async (t) => {
  const { AudioManager, window } = await loadManagerClass(t);
  const { manager } = createManager(AudioManager, deferred());
  manager.isProcessing = false;
  const dismissCalls = [];
  window.electronAPI.dismissDictationPreview = () => {
    dismissCalls.push(true);
    return Promise.resolve({ success: true });
  };

  assert.equal(manager.cancelProcessing(), false);
  assert.equal(dismissCalls.length, 0);
});

// A prior batch cancellation must never transfer into a later streaming
// session's no-speech fallback. The processing generation belongs only to the
// batch pipeline that captured it.
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
    _processingCancellationGeneration: 0,
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

test("a cancelled batch pipeline cannot clear newer streaming finalization", async (t) => {
  const { AudioManager } = await loadCancelGuardManagerClass(t);
  const { manager } = createStreamingLeakManager(AudioManager);
  const oldTranscription = deferred();
  manager.isRecording = false;
  manager.isProcessing = true;
  manager.isStreaming = false;
  manager._localSpeechGateState = null;
  manager.processWithOpenWhisprCloud = () => oldTranscription.promise;

  const oldRun = manager.processAudio(new Blob(["old"], { type: "audio/webm" }));
  assert.equal(manager.cancelProcessing(), true);

  manager.isRecording = true;
  manager.isStreaming = true;
  manager.streamingFinalText = "new streaming result";
  manager.recordingStartTime = Date.now() - 1000;
  globalThis.__streamingLeakCleanupFailureCalls = [];
  const streamingStop = manager.stopStreamingRecording();
  assert.equal(manager.isProcessing, true);

  oldTranscription.resolve({ success: true, text: "old", source: "openwhispr", timings: {} });
  await oldRun;
  const remainedBusy = manager.isProcessing;
  await streamingStop;

  assert.equal(
    remainedBusy,
    true,
    "the old batch owner must not clear a newer streaming finalization"
  );
});

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

    // Simulate an earlier batch cancellation. The new streaming session does
    // not capture that batch pipeline's old generation.
    manager._processingCancellationGeneration = 1;

    assert.equal(await manager.stopStreamingRecording(), true);

    assert.equal(completions.length, 1);
    assert.equal(completions[0].text, "the raw transcript");
    assert.equal(
      completions[0].cleanupFailure?.message,
      "genuine cloud reasoning failure",
      "a genuine cloud-reasoning failure in the streaming fallback must survive until paste"
    );
    assert.deepEqual(
      globalThis.__streamingLeakCleanupFailureCalls,
      [],
      "cleanup failure must not be surfaced before the raw dictation is pasted"
    );
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

    const result = await manager.processWithOpenWhisprCloud(
      {
        size: 1024,
        type: "audio/webm",
        arrayBuffer: async () => new ArrayBuffer(8),
      },
      {},
      () => true
    );

    assert.equal(result.text, "the raw transcript", "the raw transcript is still returned");
    assert.deepEqual(
      errors,
      [],
      "a cancelled agent command must notify nothing, not even Agent Unavailable"
    );
  }
);
