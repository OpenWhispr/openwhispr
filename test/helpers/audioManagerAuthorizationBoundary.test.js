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
  window.electronAPI.startDictationPreview = (options) => previewStarts.push(options);
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
  assert.deepEqual(previewStarts, [
    {
      provider: "nvidia",
      model: "managed-model-b",
      language: "en",
      display: true,
    },
  ]);
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

  for (const listener of [...globalThis.__audioAuthorizationListeners]) listener();

  assert.equal(abortCalls, 1);
  active.cleanup();
});
