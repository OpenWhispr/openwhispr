const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.state = { isRecording: false, isProcessing: false, isStreaming: false };
    this.sttConfig = { success: true };
    this.voiceAgentRequested = false;
    this.translationRequested = false;
  }
  getState() { return this.state; }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  setVoiceAgentRequested(value) { this.voiceAgentRequested = value; }
  setAssistantSelectionContext() {}
  setTranslationRequested(value) { this.translationRequested = value; }
  shouldUseStreaming() { return false; }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  cacheMicrophoneDeviceId() {}
  getRecordingAudioLevel() { return null; }
  cleanup() {}
  async startRecording() {
    this.state = { ...this.state, isRecording: true };
    this.callbacks.onStateChange(this.state);
    return true;
  }
}
`;

const SETTINGS_STORE_SOURCE = `
export const getSettings = () => ({
  escapeCancelsDictation: globalThis.__escapeCancellationEnabled,
  pauseMediaOnDictation: false,
  voiceAgentScreenContext: false,
});
`;

const noopDispose = () => () => {};

async function runRegistrationCase(t, enabled) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__escapeCancellationEnabled;
  });

  const registered = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        onDictationForceStopped: noopDispose,
        dictationLifecycleStateChanged() {},
        registerCancelHotkey(key) {
          registered.push(key);
          return Promise.resolve({ success: true });
        },
        unregisterCancelHotkey() {
          return Promise.resolve({ success: true });
        },
      },
    },
  });
  const container = installHookDom(t);
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  globalThis.__escapeCancellationEnabled = enabled;

  const vite = await createRendererServer(t, {
    cachePrefix: `openwhispr-audio-recording-escape-cancellation-${enabled}-`,
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/stores/settingsStore": SETTINGS_STORE_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  let api;
  function Harness() {
    api = useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  await React.act(async () => api.startRecording());

  return registered;
}

test("Escape is registered only when cancellation is enabled", async (t) => {
  await t.test("enabled", async (t) => {
    assert.deepEqual(await runRegistrationCase(t, true), ["Escape"]);
  });
  await t.test("disabled", async (t) => {
    assert.deepEqual(await runRegistrationCase(t, false), []);
  });
});
