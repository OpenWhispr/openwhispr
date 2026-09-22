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
  setCallbacks(callbacks) { this.callbacks = callbacks; }
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
    const didStart = await globalThis.__cancelDuringStartMicOpen;
    if (!didStart) return false;
    this.isRecording = true;
    this.callbacks.onStateChange(this.getState());
    globalThis.__cancelDuringStartCalls.push("micOpened");
    return true;
  }
  cancelRecording() {
    globalThis.__cancelDuringStartCalls.push("cancelRecording");
    this.isRecording = false;
    this.callbacks.onStateChange(this.getState());
    return true;
  }
  async cancelStreamingRecording() {
    globalThis.__cancelDuringStartCalls.push("cancelStreamingRecording");
    this.isRecording = false;
    this.callbacks.onStateChange(this.getState());
    return true;
  }
  stopRecording() {
    globalThis.__cancelDuringStartCalls.push("stopRecording");
    this.isRecording = false;
    this.callbacks.onStateChange(this.getState());
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
async function runCancellationScenario(
  t,
  { path = "preparation", boundary = "mic", didStart = true } = {}
) {
  // t.after hooks run in registration order, so this unmount must be
  // registered before installBrowserGlobals/installHookDom's own cleanup.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const calls = [];
  globalThis.__cancelDuringStartCalls = calls;
  t.after(() => {
    delete globalThis.__cancelDuringStartCalls;
    delete globalThis.__cancelDuringStartMicOpen;
    delete globalThis.__cancelDuringStartFrames;
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
      "/utils/visualFrame":
        "export const waitForVisualFrames = () => globalThis.__cancelDuringStartFrames;",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  let api;
  const events = [];
  const toast = () => {};
  const onDemoEvent = (event) => events.push(event);
  function Harness() {
    api = useAudioRecording(toast, { onDemoEvent });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  assert.equal(typeof cancelPreparation, "function");

  for (let attempt = 0; attempt < 2; attempt++) {
    const mic = Promise.withResolvers();
    const frames = Promise.withResolvers();
    globalThis.__cancelDuringStartMicOpen = mic.promise;
    globalThis.__cancelDuringStartFrames = frames.promise;
    if (boundary === "mic") frames.resolve();
    calls.length = 0;
    events.length = 0;
    let startPromise;
    await React.act(async () => {
      startPromise = api.startRecording();
      await Promise.resolve();
    });
    assert.equal(calls.includes("startRecording"), boundary === "mic");
    assert.deepEqual(
      events.map((event) => event.status),
      ["preparing"]
    );
    await React.act(async () => {
      if (path === "recording") await api.cancelRecording();
      else cancelPreparation();
    });
    assert.deepEqual(
      events.map((event) => event.status),
      ["preparing", "cancelled"],
      "cancellation is prompt and singular"
    );
    let started;
    await React.act(async () => {
      frames.resolve();
      mic.resolve(didStart);
      started = await startPromise;
    });
    assert.equal(started, false, "a cancelled start must not report success");
    assert.equal(
      api.isRecording,
      false,
      "any microphone that opened after cancellation is torn down"
    );
    assert.deepEqual(
      events.map((event) => event.status),
      ["preparing", "cancelled"],
      "deferred startup cannot republish listening or cancellation"
    );
    if (boundary === "mic" && didStart) {
      assert.ok(
        calls.indexOf("cancelRecording", calls.indexOf("micOpened")) > calls.indexOf("micOpened")
      );
    }
  }
}

test("a cancel that lands while the start is still awaiting the mic tears the recording down", async (t) => {
  await runCancellationScenario(t);
});

for (const path of ["recording", "preparation"]) {
  for (const scenario of [
    { boundary: "frames", didStart: false },
    { boundary: "mic", didStart: false },
    { boundary: "mic", didStart: true },
  ]) {
    if (path === "preparation" && scenario.boundary === "mic" && scenario.didStart) continue;
    test(`${path} cancellation publishes once per attempt while ${scenario.boundary} is pending and startup ${scenario.didStart ? "succeeds" : "fails"}`, async (t) => {
      await runCancellationScenario(t, { path, ...scenario });
    });
  }
}
