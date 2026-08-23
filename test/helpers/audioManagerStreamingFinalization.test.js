const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function loadManagerClass(t) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-finalization-test-",
    settingsKey: "__streamingFinalizationSettings",
    settings: {
      useLocalWhisper: false,
      transcriptionMode: "providers",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
    },
  });
  return AudioManager;
}

function createFinalizingManager(AudioManager) {
  const states = [];
  let providerStopCalls = 0;
  let providerAbortCalls = 0;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    isStreaming: true,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    recordingStartTime: Date.now(),
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 7,
    _activeStreamingSessionId: 7,
    _activeStreamingTransportId: "streaming-7",
    _streamingMicSwapPromise: null,
    streamingFinalText: "",
    streamingPartialText: "",
    streamingTextBump: null,
    streamingTextDebounce: null,
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
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => null,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      finalize() {},
      async stop() {
        providerStopCalls += 1;
        return { success: true };
      },
      async abort() {
        providerAbortCalls += 1;
        return { success: true };
      },
    }),
    getEffectiveSttLanguage: () => "auto",
    getStreamingProviderName: () => "openai",
    shouldUseStreaming: () => false,
    isRecordingAllowedByPolicy: () => true,
    onStateChange: (state) => states.push(state),
    onTranscriptionComplete() {},
  });
  return {
    manager,
    states,
    getProviderStopCalls: () => providerStopCalls,
    getProviderAbortCalls: () => providerAbortCalls,
  };
}

test("streaming finalization is immediately processing and cannot start another session", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager, states, getProviderStopCalls, getProviderAbortCalls } =
    createFinalizingManager(AudioManager);

  const firstStop = manager.stopStreamingRecording();

  assert.equal(manager.isProcessing, true);
  assert.equal(manager.getState().isFinalizingStreaming, true);
  assert.deepEqual(states[0], {
    isRecording: false,
    isProcessing: true,
    isStreaming: false,
  });

  assert.equal(await manager.startStreamingRecording(), false);
  const duplicateStop = manager.stopStreamingRecording();
  assert.deepEqual(await Promise.all([firstStop, duplicateStop]), [true, true]);

  assert.equal(getProviderStopCalls(), 1);
  assert.equal(getProviderAbortCalls(), 0);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.getState().isFinalizingStreaming, false);
  assert.equal(states.filter((state) => state.isProcessing).length, 1);
  assert.deepEqual(states.at(-1), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
  });
});

test("streaming silence publishes its empty outcome only after processing settles", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const order = [];
  manager.onStateChange = (state) => {
    order.push(state.isProcessing ? "processing" : "idle");
  };
  manager.onTranscriptionComplete = (result) => {
    order.push(result.text === "" ? "empty" : "transcript");
  };

  await manager.stopStreamingRecording();

  assert.deepEqual(order, ["processing", "idle", "empty"]);
});

test("cancelling an active streaming recording discards it without publishing text", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager, states, getProviderStopCalls, getProviderAbortCalls } =
    createFinalizingManager(AudioManager);
  const completions = [];
  manager.streamingFinalText = "discard me";
  manager.cleanupPreview = async () => null;
  manager.onTranscriptionComplete = (result) => completions.push(result);

  assert.equal(await manager.cancelStreamingRecording(), true);

  assert.equal(getProviderStopCalls(), 0);
  assert.equal(getProviderAbortCalls(), 1);
  assert.deepEqual(completions, []);
  assert.equal(manager._activeStreamingSessionId, null);
  assert.equal(manager.isRecording, false);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.isStreaming, false);
  assert.deepEqual(states.at(-1), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
  });
});

test("streaming discard aborts without invoking the provider's graceful stop", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const calls = [];
  manager.cleanupPreview = async () => null;
  manager.getStreamingProvider = () => ({
    abort: async () => {
      calls.push("abort");
      return { success: true };
    },
    stop: async () => {
      calls.push("stop");
      return { success: true };
    },
  });

  assert.equal(await manager.cancelStreamingRecording(), true);
  assert.deepEqual(calls, ["abort"]);
});

test("streaming discard blocks restart until the provider disconnects", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  let resolveProviderAbort;
  let providerAbortStarted = false;
  const providerAbort = new Promise((resolve) => {
    resolveProviderAbort = resolve;
  });
  manager.cleanupPreview = async () => null;
  manager.getStreamingProvider = () => ({
    abort: async () => {
      providerAbortStarted = true;
      await providerAbort;
      return { success: true };
    },
  });

  const cancel = manager.cancelStreamingRecording();
  while (!providerAbortStarted) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.isProcessing, true);
  assert.equal(manager.getState().isFinalizingStreaming, true);
  assert.equal(await manager.startStreamingRecording(), false);

  resolveProviderAbort();
  assert.equal(await cancel, true);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.getState().isFinalizingStreaming, false);
});

test("streaming discard waits for an in-progress provider start before disconnecting", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  let providerAbortCalls = 0;
  manager.streamingStartInProgress = true;
  manager.cleanupPreview = async () => null;
  manager.getStreamingProvider = () => ({
    abort: async () => {
      providerAbortCalls += 1;
      return { success: true };
    },
  });

  const cancel = manager.cancelStreamingRecording();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerAbortCalls, 0);
  assert.equal(manager.isProcessing, true);

  manager._settleStreamingStart();
  assert.equal(await cancel, true);
  assert.equal(providerAbortCalls, 1);
  assert.equal(manager.isProcessing, false);
});

test("cancelling while the streaming microphone opens never enters recording", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const states = [];
  let resolveMicOpen;
  let micOpenStarted = false;
  const micOpen = new Promise((resolve) => {
    resolveMicOpen = resolve;
  });
  const previousAudioWorkletNode = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { postMessage() {} };
    }

    disconnect() {}
  };
  t.after(() => {
    if (previousAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = previousAudioWorkletNode;
  });

  const stream = {
    getAudioTracks: () => [{ getSettings: () => ({}) }],
    getTracks: () => [{ stop() {} }],
  };
  const source = { connect() {}, disconnect() {} };
  const provider = {
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
    onSessionEnd: () => () => {},
    start: async () => ({ success: true }),
    stop: async () => ({ success: true }),
    abort: async () => ({ success: true }),
  };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 0,
    _activeStreamingSessionId: null,
    streamingCleanupFns: [],
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    streamingTextDebounce: null,
    preparedMicCapture: { take: async () => null },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => {
      micOpenStarted = true;
      return micOpen;
    },
    startStreamingFallbackRecorder() {},
    getOrCreateAudioContext: async () => ({
      createMediaStreamSource: () => source,
      createAnalyser: () => ({}),
      audioWorklet: { addModule: async () => {} },
    }),
    getWorkletBlobUrl: () => "",
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => "openai",
    getEffectiveSttLanguage: () => "auto",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    cleanupPreview: async () => null,
    _markCaptureStreamReleased() {},
    onStateChange: (state) => states.push(state),
  });

  const start = manager.startStreamingRecording();
  while (!micOpenStarted) await new Promise((resolve) => setImmediate(resolve));
  const cancel = manager.cancelStreamingRecording();
  resolveMicOpen(stream);

  assert.deepEqual(await Promise.all([start, cancel]), [false, true]);
  assert.equal(manager.isRecording, false);
  assert.equal(manager.isStreaming, false);
  assert.equal(manager.streamingStartInProgress, false);
  assert.equal(
    states.some((state) => state.isRecording),
    false,
    "a cancelled start must not publish a recording state"
  );
});

test("authorization invalidation after provider start aborts the exact requested transport", async (t) => {
  let authorizationCurrent = true;
  globalThis.__streamingStartAuthorizationCurrent = () => authorizationCurrent;
  t.after(() => delete globalThis.__streamingStartAuthorizationCurrent);
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-start-auth-race-test-",
    settingsKey: "__streamingStartAuthRaceSettings",
    settings: {
      useLocalWhisper: false,
      transcriptionMode: "providers",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
    },
    mockModules: {
      "runtimeAuthorizationBoundary.ts": `
        export const captureRuntimeAuthorizationGuard = () => ({
          isCurrent: () => globalThis.__streamingStartAuthorizationCurrent(),
          assertCurrent() {
            if (!this.isCurrent()) {
              const error = new Error('Authorization changed');
              error.code = 'AUTHORIZATION_BOUNDARY_CHANGED';
              throw error;
            }
          },
        });
        export const subscribeRuntimeAuthorizationBoundary = () => () => {};
      `,
    },
  });
  const previousAudioWorkletNode = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }

    disconnect() {}
  };
  t.after(() => {
    if (previousAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = previousAudioWorkletNode;
  });

  const providerStart = createDeferred();
  const abortTransportIds = [];
  let requestedTransportId = null;
  let providerActive = false;
  const provider = {
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
    onSessionEnd: () => () => {},
    async start(options) {
      requestedTransportId = options.transportId;
      await providerStart.promise;
      providerActive = true;
      return { success: true, transportId: options.transportId };
    },
    send() {},
    async abort(transportId) {
      abortTransportIds.push(transportId);
      if (transportId === requestedTransportId) providerActive = false;
      return { success: true };
    },
  };
  const stream = {
    getAudioTracks: () => [{ label: "test", getSettings: () => ({}) }],
    getTracks: () => [{ stop() {} }],
  };
  const source = { connect() {}, disconnect() {} };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _streamingSessionGeneration: 0,
    _activeStreamingSessionId: null,
    _activeStreamingTransportId: null,
    _warmStreamingProviderName: null,
    _warmStreamingTransportId: null,
    streamingCleanupFns: [],
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    streamingTextDebounce: null,
    workletModuleLoaded: true,
    preparedMicCapture: { take: async () => null },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => stream,
    startStreamingFallbackRecorder() {},
    getOrCreateAudioContext: async () => ({
      createMediaStreamSource: () => source,
      createAnalyser: () => ({ fftSize: 0 }),
    }),
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => "openai",
    getEffectiveSttLanguage: () => "auto",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    _markCaptureStreamReleased() {},
    onStateChange() {},
  });

  const starting = manager.startStreamingRecording();
  while (!requestedTransportId) await new Promise((resolve) => setImmediate(resolve));
  authorizationCurrent = false;
  providerStart.resolve();

  assert.equal(await starting, false);
  assert.deepEqual(abortTransportIds, [requestedTransportId]);
  assert.equal(providerActive, false);
});

test("graceful stop releases its transport before re-warm and buffers the next session's early PCM", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const providerStart = createDeferred();
  const sentAudio = [];
  const abortedTransportIds = [];
  let streamingPort = null;
  const previousAudioWorkletNode = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class {
    constructor() {
      streamingPort = { onmessage: null, postMessage() {} };
      this.port = streamingPort;
    }

    disconnect() {}
  };
  t.after(() => {
    if (previousAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = previousAudioWorkletNode;
  });

  const provider = {
    awaitsFinalTranscript: true,
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
    onSessionEnd: () => () => {},
    finalize() {},
    async stop() {
      return { success: true };
    },
    async warmup() {
      return { success: true };
    },
    async start() {
      await providerStart.promise;
      return { success: true, transportId: "streaming-rewarm-3" };
    },
    send(transportId, pcm) {
      sentAudio.push([transportId, pcm]);
    },
    async abort(transportId) {
      abortedTransportIds.push(transportId);
      return { success: true };
    },
  };
  const stream = {
    getAudioTracks: () => [{ label: "test", getSettings: () => ({}) }],
    getTracks: () => [{ stop() {} }],
  };
  const source = { connect() {}, disconnect() {} };
  Object.assign(manager, {
    _warmStreamingTransportId: null,
    _warmStreamingProviderName: null,
    workletModuleLoaded: true,
    preparedMicCapture: { take: async () => null },
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => stream,
    startStreamingFallbackRecorder() {},
    getOrCreateAudioContext: async () => ({
      createMediaStreamSource: () => source,
      createAnalyser: () => ({ fftSize: 0 }),
    }),
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => "openai",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    _markCaptureStreamReleased() {},
    shouldUseStreaming: () => true,
    warmupStreamingConnection: async () => {
      manager._warmStreamingTransportId = "streaming-rewarm-2";
      manager._warmStreamingProviderName = "openai";
      return true;
    },
    _requestStreamingCancellation() {},
    cancelPreparedMicCapture() {},
  });

  assert.equal(await manager.stopStreamingRecording(), true);
  assert.equal(manager._activeStreamingTransportId, null);
  assert.equal(manager._warmStreamingTransportId, "streaming-rewarm-2");

  globalThis.window.electronAPI.dictationStreamingAbort = async (transportId) => {
    abortedTransportIds.push(transportId);
    return { success: true };
  };
  manager._handleRuntimeAuthorizationBoundaryChange();
  assert.deepEqual(abortedTransportIds, ["streaming-rewarm-2"]);

  manager._warmStreamingTransportId = "streaming-rewarm-3";
  const starting = manager.startStreamingRecording();
  while (!streamingPort?.onmessage) await new Promise((resolve) => setImmediate(resolve));
  const earlyPcm = new Int16Array([1, 2, 3]).buffer;
  streamingPort.onmessage({ data: earlyPcm });
  assert.deepEqual(sentAudio, []);

  providerStart.resolve();
  assert.equal(await starting, true);
  assert.deepEqual(sentAudio, [["streaming-rewarm-3", earlyPcm]]);
});

test("cancel overrides a normal streaming stop before it can publish text", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const completions = [];
  manager.streamingFinalText = "do not paste";
  manager.screenContextPromise = Promise.resolve({ data: "stale-screen" });
  manager.selectionCapturePromise = Promise.resolve({ text: "stale-selection" });
  manager.assistantSelectionContext = { text: "stale-assistant-selection" };
  manager.onTranscriptionComplete = (result) => completions.push(result);

  const stop = manager.stopStreamingRecording();
  const cancel = manager.cancelStreamingRecording();

  assert.equal(await stop, true);
  assert.equal(await cancel, true);
  assert.deepEqual(completions, []);
  assert.equal(manager.screenContextPromise, null);
  assert.equal(manager.selectionCapturePromise, null);
  assert.equal(manager.assistantSelectionContext, null);
  assert.equal(manager._streamingStopPromise, null);
  assert.equal(manager._streamingStopMode, null);
});

test("streaming cancellation aborts a BYOK fallback transcription request", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  let abortCalls = 0;
  manager._activeTranscriptionAbortController = {
    abort() {
      abortCalls += 1;
    },
  };

  manager._requestStreamingCancellation();

  assert.equal(abortCalls, 1);
  assert.equal(manager._activeTranscriptionAbortController, null);
});

test("cancelling streaming processing stays busy until an awaited transform exits", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const completions = [];
  let resolveTransform;
  let transformStarted = false;
  const transform = new Promise((resolve) => {
    resolveTransform = resolve;
  });
  t.after(() => resolveTransform?.("test cleanup"));
  manager.streamingFinalText = "raw transcript";
  manager.finalizeChineseScript = async () => {
    transformStarted = true;
    return transform;
  };
  manager.onTranscriptionComplete = (result) => completions.push(result);

  const stop = manager.stopStreamingRecording();
  while (!transformStarted) await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.equal(manager.cancelProcessing(), true);
    assert.equal(manager.isProcessing, true);
    assert.equal(manager.getState().isFinalizingStreaming, true);
  } finally {
    resolveTransform("transformed transcript");
  }
  assert.equal(await stop, true);

  assert.deepEqual(completions, []);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.getState().isFinalizingStreaming, false);
});

test("an older streaming session cannot clean up the active session listeners", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    _activeStreamingSessionId: 12,
    streamingCleanupFns: [() => assert.fail("stale cleanup ran")],
    streamingFinalText: "current transcript",
    streamingPartialText: "current partial",
    streamingTextBump: null,
    streamingTextDebounce: null,
  });

  manager.cleanupStreamingListeners(11);

  assert.equal(manager.streamingCleanupFns.length, 1);
  assert.equal(manager.streamingFinalText, "current transcript");
  assert.equal(manager.streamingPartialText, "current partial");
});
