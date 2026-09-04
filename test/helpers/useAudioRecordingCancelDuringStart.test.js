const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// An AudioManager stand-in whose startRecording() parks until the test opens
// the mic, reproducing a cold first dictation (micReadyMs measured at ~3.2 s
// in the field against ~50 ms warm). isRecording stays false for that whole
// window, which is precisely when the cancel arrives in the bug this covers.
// Calls are recorded on globalThis: the SSR module graph and the test share
// one realm, so that is the only channel between them.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.isRecording = false;
    this.sttConfig = { success: true };
  }
  getState() {
    return {
      isRecording: this.isRecording,
      isStreaming: false,
      isStreamingStartInProgress: false,
    };
  }
  setCallbacks() {}
  setVoiceAgentRequested() {}
  setAssistantSelectionContext() {}
  setTranslationRequested() {}
  shouldUseStreaming() {
    return false;
  }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {
    globalThis.__cancelDuringStartCalls.push("cancelPreparedMicCapture");
  }
  cleanup() {}
  async startRecording() {
    globalThis.__cancelDuringStartCalls.push("startRecording");
    await globalThis.__cancelDuringStartMicOpen;
    this.isRecording = true;
    globalThis.__cancelDuringStartCalls.push("micOpened");
    return true;
  }
  cancelRecording() {
    globalThis.__cancelDuringStartCalls.push("cancelRecording");
    this.isRecording = false;
    return true;
  }
  async cancelStreamingRecording() {
    globalThis.__cancelDuringStartCalls.push("cancelStreamingRecording");
    this.isRecording = false;
    return true;
  }
  stopRecording() {
    globalThis.__cancelDuringStartCalls.push("stopRecording");
    this.isRecording = false;
    return true;
  }
}
`;

// Regression: double-tap Globe to latch hands-free, then Fn+Left inside the
// recent-latch window. The main process cancels (windowManager.interruptPushGesture
// -> sendCancelDictation -> "cancel-dictation-preparation"), but with a cold mic
// the start is still awaiting the device, so the cancel used to be dropped and
// the mic opened seconds later into an unstoppable hands-free recording.
// Testbook step B2; the warm-mic path (isRecording already true) always passed.
test("a cancel that lands while the start is still awaiting the mic tears the recording down", async (t) => {
  // t.after hooks run in registration order, so this unmount must be
  // registered before installBrowserGlobals/installHookDom's own cleanup.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const calls = [];
  globalThis.__cancelDuringStartCalls = calls;
  let openMic;
  globalThis.__cancelDuringStartMicOpen = new Promise((resolve) => {
    openMic = resolve;
  });
  t.after(() => {
    delete globalThis.__cancelDuringStartCalls;
    delete globalThis.__cancelDuringStartMicOpen;
  });

  const noopDispose = () => () => {};
  let cancelPreparation = null;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onPrepareDictation: noopDispose,
        // The channel the Fn-combo interrupt actually arrives on.
        onCancelDictationPreparation: (callback) => {
          cancelPreparation = callback;
          return () => {};
        },
        onStopDictation: noopDispose,
        dictationLifecycleStateChanged: () => {},
      },
    },
  });
  const container = installHookDom(t);
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-cancel-during-start-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
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

  assert.equal(typeof cancelPreparation, "function");

  let startPromise;
  await React.act(async () => {
    startPromise = api.startRecording();
    // Let performStartRecording reach the parked startRecording() call.
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["startRecording"], "the start should be parked on the mic open");

  await React.act(async () => {
    cancelPreparation();
  });

  let started;
  await React.act(async () => {
    openMic();
    started = await startPromise;
  });

  assert.equal(
    calls.includes("cancelRecording") || calls.includes("cancelStreamingRecording"),
    true,
    "the recording that opened after the cancel must be torn down, not left live"
  );
  assert.equal(started, false, "the start must not report success once it has been cancelled");
});
