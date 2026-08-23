const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("batch preview starts the exact managed transcription model", async (t) => {
  const staleSettings = {
    micWarmHoldSeconds: 0,
    showTranscriptionPreview: true,
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel: "stale-model-a",
    whisperModel: "stale-whisper-a",
    preferredLanguage: "en-US",
  };
  const managedSettings = {
    ...staleSettings,
    transcriptionMode: "local",
    parakeetModel: "managed-model-b",
    whisperModel: "managed-whisper-b",
  };
  globalThis.__managedPreviewSettings = managedSettings;
  t.after(() => delete globalThis.__managedPreviewSettings);
  const { window, AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-managed-preview-auth-test-",
    settingsKey: "__managedPreviewPersistedSettings",
    settings: staleSettings,
    mockModules: {
      "managedLocalTranscriptionRuntime.ts": `
        export const resolveManagedLocalTranscriptionRuntime = () => ({
          kind: 'ready',
          managed: true,
          settings: globalThis.__managedPreviewSettings,
        });
        export const isManagedLocalTranscriptionRuntimeAllowed = (resolution) =>
          resolution.kind === 'ready';
        export const captureManagedRuntimeAuthorizationContext = (route) => ({
          accountId: 'managed-account',
          workspaceId: 'managed-workspace',
          authGeneration: 7,
          configGeneration: 11,
          policyRevision: 5,
          category: 'transcription',
          ...route,
        });
      `,
    },
  });
  const originalAudioContext = globalThis.AudioContext;
  const originalAudioWorkletNode = globalThis.AudioWorkletNode;
  const source = { connect() {}, disconnect() {} };
  globalThis.AudioContext = class {
    constructor() {
      this.state = "running";
      this.audioWorklet = { addModule: async () => {} };
    }

    createAnalyser() {
      return {
        fftSize: 0,
        getByteTimeDomainData() {},
      };
    }

    createMediaStreamSource() {
      return source;
    }

    resume() {
      return Promise.resolve();
    }
  };
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }

    disconnect() {}
  };
  t.after(() => {
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
    if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = originalAudioWorkletNode;
  });

  const previewStarts = [];
  window.electronAPI.startDictationPreview = async (options, context) => {
    previewStarts.push({ options, context });
    return { success: true, transportId: options.transportId };
  };
  const track = {
    label: "test mic",
    muted: false,
    readyState: "live",
    getSettings: () => ({}),
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStopPromise: null,
    mediaRecorder: null,
    voiceAgentRequested: false,
    preparedMicCapture: { take: async () => null },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => stream,
    createBatchRecorder() {},
    beginMicRecovery: async () => {},
    getWorkletBlobUrl: () => "worklet.js",
    _markCaptureStreamReleased() {},
  });
  t.after(() => clearInterval(manager._silenceInterval));

  assert.equal(await manager.startRecording(), true);
  assert.equal(previewStarts.length, 1);
  assert.match(previewStarts[0].options.transportId, /^[0-9a-f-]{36}$/i);
  const { transportId: _transportId, ...previewOptions } = previewStarts[0].options;
  assert.deepEqual(
    [{ options: previewOptions, context: previewStarts[0].context }],
    [
      {
        options: {
          provider: "nvidia",
          model: "managed-model-b",
          language: "en",
          display: true,
        },
        context: {
          accountId: "managed-account",
          workspaceId: "managed-workspace",
          authGeneration: 7,
          configGeneration: 11,
          policyRevision: 5,
          category: "transcription",
          transcriptionMode: "local",
          managed: true,
          provider: "nvidia",
          model: "managed-model-b",
        },
      },
    ]
  );
});

test("preview audio waits for authorization and forwards the first PCM chunk with its transport", async (t) => {
  const settings = {
    micWarmHoldSeconds: 0,
    showTranscriptionPreview: true,
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    whisperModel: "base",
    preferredLanguage: "en-US",
  };
  const { window, AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-preview-start-boundary-test-",
    settingsKey: "__previewStartBoundarySettings",
    settings,
  });
  const originalAudioContext = globalThis.AudioContext;
  const originalAudioWorkletNode = globalThis.AudioWorkletNode;
  let sourceConnects = 0;
  let processor;
  const source = {
    connect(target) {
      if (target === processor) sourceConnects += 1;
    },
    disconnect() {},
  };
  globalThis.AudioContext = class {
    constructor() {
      this.state = "running";
      this.audioWorklet = { addModule: async () => {} };
    }

    createAnalyser() {
      return { fftSize: 0, getByteTimeDomainData() {} };
    }

    createMediaStreamSource() {
      return source;
    }

    resume() {
      return Promise.resolve();
    }
  };
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
      processor = this;
    }

    disconnect() {}
  };
  t.after(() => {
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
    if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = originalAudioWorkletNode;
  });

  let resolveStart;
  const startResult = new Promise((resolve) => {
    resolveStart = resolve;
  });
  window.electronAPI.startDictationPreview = () => startResult;
  const sent = [];
  window.electronAPI.sendDictationPreviewAudio = (...args) => sent.push(args);
  const track = { label: "test mic", muted: false, readyState: "live", getSettings: () => ({}) };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStopPromise: null,
    mediaRecorder: null,
    voiceAgentRequested: false,
    preparedMicCapture: { take: async () => null },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => stream,
    createBatchRecorder() {},
    beginMicRecovery: async () => {},
    getWorkletBlobUrl: () => "worklet.js",
    _markCaptureStreamReleased() {},
  });
  t.after(() => clearInterval(manager._silenceInterval));

  let settled = false;
  const starting = manager.startRecording().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeAuthorization = settled;
  const connectsBeforeAuthorization = sourceConnects;
  processor.port.onmessage?.({ data: new ArrayBuffer(4) });
  const sendsBeforeAuthorization = [...sent];

  resolveStart({ success: true, transportId: "preview-transport" });

  assert.equal(await starting, true);
  assert.equal(settledBeforeAuthorization, false);
  assert.equal(connectsBeforeAuthorization, 0);
  assert.deepEqual(sendsBeforeAuthorization, []);
  assert.equal(sourceConnects, 1);
  const pcm = new ArrayBuffer(8);
  processor.port.onmessage({ data: pcm });
  assert.deepEqual(sent, [["preview-transport", pcm]]);

  await t.test("authorization rejection never connects or forwards preview PCM", async () => {
    clearInterval(manager._silenceInterval);
    manager._silenceInterval = null;
    manager.isRecording = false;
    window.electronAPI.startDictationPreview = async () => ({
      success: false,
      error: "Transcription authorization changed. Retry the request.",
      code: "AUTHORIZATION_BOUNDARY_CHANGED",
    });
    const connectedBeforeRejectedStart = sourceConnects;
    const sentBeforeRejectedStart = sent.length;

    assert.equal(await manager.startRecording(), true);
    assert.equal(sourceConnects, connectedBeforeRejectedStart);
    processor.port.onmessage?.({ data: new ArrayBuffer(4) });
    assert.equal(sent.length, sentBeforeRejectedStart);
  });
});

test("cleanup unsubscribes authorization changes before a later manager is created", async (t) => {
  globalThis.__audioAuthorizationListeners = new Set();
  t.after(() => delete globalThis.__audioAuthorizationListeners);
  const { window, AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-auth-lifecycle-test-",
    settingsKey: "__audioAuthorizationLifecycleSettings",
    settings: {
      micWarmHoldSeconds: 0,
      useLocalWhisper: false,
      cloudTranscriptionProvider: "openai",
    },
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__audioAuthorizationLifecycleSettings;
        export const getEffectiveCleanupModel = () => null;
        export const selectResolvedLLMConfig = () => ({ model: null, provider: null });
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
        export const useSettingsStore = { subscribe: () => () => {} };
      `,
      "runtimeAuthorizationBoundary.ts": `
        export const captureRuntimeAuthorizationGuard = () => ({
          isCurrent: () => true,
          assertCurrent() {},
        });
        export const subscribeRuntimeAuthorizationBoundary = (_domains, callback) => {
          globalThis.__audioAuthorizationListeners.add(callback);
          return () => globalThis.__audioAuthorizationListeners.delete(callback);
        };
      `,
    },
  });
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: {} },
  });
  t.after(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  });

  let abortCalls = 0;
  window.electronAPI.dictationStreamingAbort = async () => {
    abortCalls += 1;
    return { success: true };
  };
  const disposed = new AudioManager();
  disposed.cleanup();
  abortCalls = 0;
  const active = new AudioManager();
  active._warmStreamingTransportId = "authorization-warmup";

  for (const listener of [...globalThis.__audioAuthorizationListeners]) listener();

  assert.equal(abortCalls, 1);
  active.cleanup();
});

test("cloud cleanup does not retry after its authorization boundary changes", async (t) => {
  globalThis.__translationBoundaryCancelled = false;
  t.after(() => delete globalThis.__translationBoundaryCancelled);
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-translation-cleanup-auth-test-",
    settingsKey: "__translationCleanupAuthorizationSettings",
    settings: {},
    mockModules: {
      "/lib/auth": `
        export const withSessionRefresh = async (operation) => {
          globalThis.__translationBoundaryCancelled = true;
          return operation();
        };
      `,
    },
  });

  let cloudDispatches = 0;
  window.electronAPI.cloudReason = async () => {
    cloudDispatches += 1;
    return { success: true, text: "cleaned" };
  };
  const manager = createManager({
    getCustomPrompt: () => undefined,
    getCleanupLanguage: () => "en",
    notifyTranslationFallback() {},
  });

  await assert.rejects(
    () =>
      manager.runTranslationChain({
        text: "raw",
        settings: {},
        agentName: null,
        route: { cleanupReachable: true, model: "translate", config: {} },
        cleanup: { mode: "cloudReason", log: {} },
        wasCancelled: () => globalThis.__translationBoundaryCancelled,
      }),
    { name: "AbortError" }
  );
  assert.equal(cloudDispatches, 0);
});

test("streaming cloud cleanup does not dispatch after finalization authorization changes", async (t) => {
  globalThis.__streamingCleanupBoundaryChanged = false;
  t.after(() => delete globalThis.__streamingCleanupBoundaryChanged);
  const { window, AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-cleanup-auth-test-",
    settingsKey: "__streamingCleanupAuthorizationSettings",
    settings: { useCleanupModel: true, customPrompts: {} },
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__streamingCleanupAuthorizationSettings;
        export const getEffectiveCleanupModel = () => null;
        export const selectResolvedLLMConfig = () => ({
          mode: "openwhispr",
          cloudMode: "openwhispr",
          model: null,
          provider: null,
        });
        export const isCloudCleanupMode = () => true;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/lib/auth": `
        export const withSessionRefresh = async (operation) => {
          globalThis.__streamingCleanupBoundaryChanged = true;
          return operation();
        };
      `,
      "runtimeAuthorizationBoundary.ts": `
        export const captureRuntimeAuthorizationGuard = () => ({
          isCurrent: () => !globalThis.__streamingCleanupBoundaryChanged,
          assertCurrent() {
            if (globalThis.__streamingCleanupBoundaryChanged) {
              throw Object.assign(new Error("Authorization changed"), { name: "AbortError" });
            }
          },
        });
        export const subscribeRuntimeAuthorizationBoundary = () => () => {};
      `,
    },
  });

  let cloudDispatches = 0;
  window.electronAPI.cloudReason = async () => {
    cloudDispatches += 1;
    return { success: true, text: "cleaned" };
  };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: true,
    isStreaming: false,
    _streamingCancellationGeneration: 0,
    _activeStreamingSessionId: 7,
    _streamingFallbackSegments: [],
    streamingFinalText: "raw transcript",
    streamingPartialText: "",
    streamingCleanupFns: [],
    streamingProcessor: null,
    streamingSource: null,
    streamingAnalyser: null,
    streamingAudioContext: null,
    streamingStream: null,
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    recordingStartTime: Date.now(),
    micRecovery: { stop() {} },
    awaitStreamingTextSettled: async () => {},
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      finalize() {},
      stop: async () => ({ success: true }),
      abort: async () => ({ success: true }),
    }),
    getStreamingProviderName: () => "openai",
    getEffectiveSttLanguage: () => "auto",
    getCustomPrompt: () => undefined,
    getCleanupLanguage: () => "en",
    finalizeChineseScript: async (text) => text,
    shouldUseStreaming: () => false,
    onStateChange() {},
    onTranscriptionComplete() {},
  });

  assert.equal(await manager._finalizeStreamingRecording(7), true);
  assert.equal(cloudDispatches, 0);
});
