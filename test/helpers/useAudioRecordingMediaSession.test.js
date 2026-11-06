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
    this.sttConfig = {};
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    globalThis.__mediaSessionAudioManager = this;
  }
  getState() { return this.state; }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  setVoiceAgentRequested(value) { this.voiceAgentRequested = value; }
  setAssistantSelectionContext() {}
  setTranslationRequested(value) { this.translationRequested = value; }
  setSttConfig(config) { this.sttConfig = config; }
  isSttConfigStale() { return false; }
  cacheMicrophoneDeviceId() {}
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  shouldUseStreaming() { return false; }
  getRecordingAudioLevel() { return null; }
  async startRecording() {
    this.state = { isRecording: true, isProcessing: false, isStreaming: false };
    this.callbacks.onStateChange(this.state);
    return true;
  }
  stopRecording() {
    globalThis.__mediaSessionEvents.push(["audio-stop"]);
    this.state = { isRecording: false, isProcessing: true, isStreaming: false };
    this.callbacks.onStateChange(this.state);
    return true;
  }
  cancelRecording() {
    globalThis.__mediaSessionEvents.push(["audio-cancel"]);
    this.state = { isRecording: false, isProcessing: false, isStreaming: false };
    this.callbacks.onStateChange(this.state);
    return true;
  }
  emitDuplicateEnd() {
    this.callbacks.onStateChange(this.state);
    this.callbacks.onNoAudio();
  }
  cleanup() {
    globalThis.__mediaSessionEvents.push(["audio-cleanup"]);
  }
}
`;

const SETTINGS_STORE_SOURCE = `
export const getSettings = () => globalThis.__mediaSessionSettings;
`;

const POLICY_STORE_SOURCE = `
export const usePolicyStore = {
  getState: () => ({ status: "unmanaged" }),
  subscribe: () => () => {},
};
`;

const LOGGER_SOURCE = `
const noop = () => {};
export default { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
`;

const TRANSLATION_SOURCE = `
const translate = (key) => key;
export const useTranslation = () => ({ t: translate });
`;
const NOOP = () => {};

async function mountHarness(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__mediaSessionAudioManager;
    delete globalThis.__mediaSessionEvents;
    delete globalThis.__mediaSessionSettings;
  });

  const noopDispose = () => () => {};
  globalThis.__mediaSessionEvents = [];
  globalThis.__mediaSessionSettings = {
    pauseMediaOnDictation: true,
    voiceAgentScreenContext: false,
    showTranscriptionPreview: false,
    snippets: [],
  };

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
        setScreenContextEnabled() {},
        getSttConfig: async () => ({ success: false }),
        captureDictationTarget: async () => {},
        registerCancelHotkey() {},
        unregisterCancelHotkey() {},
        pauseMediaPlayback(sessionId) {
          globalThis.__mediaSessionEvents.push(["pause", sessionId]);
        },
        resumeMediaPlayback(sessionId, restore) {
          globalThis.__mediaSessionEvents.push(["resume", sessionId, restore]);
        },
        hideDictationPreview() {},
      },
    },
  });
  const container = installHookDom(t);
  let holdFrames = false;
  const pendingFrames = [];
  globalThis.requestAnimationFrame = (callback) => {
    if (holdFrames) pendingFrames.push(callback);
    else callback();
    return 1;
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-media-session-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/stores/settingsStore": SETTINGS_STORE_SOURCE,
      "/stores/policyStore": POLICY_STORE_SOURCE,
      "/utils/logger": LOGGER_SOURCE,
      "/utils/dictationCues":
        "export const playStartCue = () => {}; export const playStopCue = () => {};",
      "react-i18next": TRANSLATION_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  let api;
  function Harness() {
    api = useAudioRecording(NOOP, { onDemoEvent: NOOP });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  return {
    start: async () => {
      let result;
      await React.act(async () => {
        result = await api.startRecording();
      });
      return result;
    },
    stop: async () => {
      let result;
      await React.act(async () => {
        result = await api.stopRecording();
      });
      return result;
    },
    cancel: async () => {
      let result;
      await React.act(async () => {
        result = await api.cancelRecording();
      });
      return result;
    },
    manager: globalThis.__mediaSessionAudioManager,
    duplicateEnd: async () =>
      React.act(async () => globalThis.__mediaSessionAudioManager.emitDuplicateEnd()),
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
    events: globalThis.__mediaSessionEvents,
    settings: globalThis.__mediaSessionSettings,
    holdFrames: () => {
      holdFrames = true;
    },
    releaseFrames: () => {
      holdFrames = false;
      while (pendingFrames.length) pendingFrames.shift()(0);
    },
  };
}

test("a recording keeps media paused until immediately before audio stop", async (t) => {
  const harness = await mountHarness(t);

  await harness.start();
  const [pause] = harness.events;
  assert.equal(pause[0], "pause");
  assert.ok(pause[1], "pause receives a recording-scoped session ID");

  harness.holdFrames();
  const stopping = harness.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.events.slice(1), [], "media stays paused during the visual wait");
  harness.releaseFrames();
  assert.equal(await stopping, true);
  assert.deepEqual(harness.events.slice(1), [["resume", pause[1], true], ["audio-stop"]]);

  await harness.duplicateEnd();
  assert.equal(
    harness.events.filter(([event]) => event === "resume").length,
    1,
    "duplicate end paths cannot emit another cleanup"
  );
});

test("unmount ends an active media session before audio cleanup", async (t) => {
  const harness = await mountHarness(t);

  await harness.start();
  const sessionId = harness.events[0][1];
  await harness.unmount();

  assert.deepEqual(harness.events.slice(1), [["resume", sessionId, true], ["audio-cleanup"]]);
});

test("disabling the setting mid-recording still ends the session without restoring", async (t) => {
  const harness = await mountHarness(t);

  await harness.start();
  const sessionId = harness.events[0][1];
  harness.settings.pauseMediaOnDictation = false;
  assert.equal(await harness.stop(), true);

  assert.deepEqual(harness.events.slice(1), [["resume", sessionId, false], ["audio-stop"]]);
});

test("cancellation ends its media session once before cancelling capture", async (t) => {
  const harness = await mountHarness(t);

  await harness.start();
  const sessionId = harness.events[0][1];
  assert.equal(await harness.cancel(), true);
  await harness.duplicateEnd();
  await harness.unmount();

  assert.deepEqual(harness.events, [
    ["pause", sessionId],
    ["resume", sessionId, true],
    ["audio-cancel"],
    ["audio-cleanup"],
  ]);
});

test("an unexpected recording end restores media without waiting for transcription", async (t) => {
  const harness = await mountHarness(t);

  await harness.start();
  const sessionId = harness.events[0][1];
  await React.act(async () => {
    harness.manager.state = { isRecording: false, isProcessing: true, isStreaming: false };
    harness.manager.callbacks.onStateChange(harness.manager.state);
  });
  await harness.duplicateEnd();

  assert.deepEqual(harness.events, [
    ["pause", sessionId],
    ["resume", sessionId, true],
  ]);
});

test("consecutive recordings use distinct media sessions with one end each", async (t) => {
  const harness = await mountHarness(t);

  await harness.start();
  const firstSessionId = harness.events[0][1];
  await harness.cancel();
  await harness.start();
  const secondSessionId = harness.events[3][1];
  assert.notEqual(secondSessionId, firstSessionId);
  await harness.stop();
  await harness.unmount();

  assert.deepEqual(harness.events, [
    ["pause", firstSessionId],
    ["resume", firstSessionId, true],
    ["audio-cancel"],
    ["pause", secondSessionId],
    ["resume", secondSessionId, true],
    ["audio-stop"],
    ["audio-cleanup"],
  ]);
});

test("enabling media pause after capture starts cannot resume a player it did not pause", async (t) => {
  const harness = await mountHarness(t);
  harness.settings.pauseMediaOnDictation = false;

  await harness.start();
  assert.deepEqual(harness.events, []);
  harness.settings.pauseMediaOnDictation = true;
  await harness.stop();
  await harness.unmount();

  assert.deepEqual(harness.events, [["audio-stop"], ["audio-cleanup"]]);
});
