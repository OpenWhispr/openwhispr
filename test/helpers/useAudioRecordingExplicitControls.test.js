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
export const audioControl = {
  constructions: 0,
  instance: null,
  starts: 0,
  stops: 0,
  resolveStart: null,
};

export default class FakeAudioManager {
  constructor() {
    audioControl.constructions += 1;
    this.state = { isRecording: false, isProcessing: false, isStreaming: false };
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = { success: true };
    audioControl.instance = this;
  }
  getState() {
    return this.state;
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  setVoiceAgentRequested(value) {
    this.voiceAgentRequested = value;
  }
  setAssistantSelectionContext() {}
  setTranslationRequested(value) {
    this.translationRequested = value;
  }
  shouldUseStreaming() {
    return false;
  }
  isSttConfigStale() {
    return false;
  }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  cleanup() {}
  async startRecording() {
    audioControl.starts += 1;
    return await new Promise((resolve) => {
      audioControl.resolveStart = () => {
        this.state = { ...this.state, isRecording: true };
        this.callbacks.onStateChange(this.state);
        resolve(true);
      };
    });
  }
  stopRecording() {
    if (!this.state.isRecording) return false;
    audioControl.stops += 1;
    this.state = { ...this.state, isRecording: false };
    this.callbacks.onStateChange(this.state);
    return true;
  }
}
`;

test("explicit renderer controls deduplicate starts and queue one stop during microphone startup", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const handlers = {};
  const settledRequests = [];
  const register = (name) => (callback) => {
    handlers[name] = callback;
    return () => delete handlers[name];
  };
  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: register("start"),
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: register("stop"),
        onDictationForceStopped: noopDispose,
        dictationLifecycleStateChanged: () => {},
        dictationStartRequestSettled: (requestId) => settledRequests.push(requestId),
        captureDictationTarget: async () => ({ success: true }),
        unregisterCancelHotkey: () => {},
      },
    },
  });
  const container = installHookDom(t);
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-explicit-controls-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { audioControl } = await vite.ssrLoadModule("/helpers/audioManager");

  const toast = () => {};
  const onDemoEvent = () => {};
  function Harness() {
    useAudioRecording(toast, { onDemoEvent });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  await React.act(async () => {
    handlers.stop();
    await Promise.resolve();
  });
  assert.equal(audioControl.stops, 0);

  await React.act(async () => {
    handlers.start(17);
    handlers.start(18);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(audioControl.starts, 1);
  assert.deepEqual(settledRequests, [18]);

  await React.act(async () => {
    handlers.stop();
    handlers.stop();
    await Promise.resolve();
  });
  assert.equal(audioControl.stops, 0);

  await React.act(async () => {
    audioControl.resolveStart();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(audioControl.starts, 1);
  assert.equal(audioControl.stops, 1);
  assert.equal(audioControl.constructions, 1);
  assert.equal(audioControl.instance.getState().isRecording, false);
  assert.deepEqual(settledRequests, [18, 17]);
});
