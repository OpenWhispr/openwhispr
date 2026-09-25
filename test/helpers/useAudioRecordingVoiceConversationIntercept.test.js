const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Records what the hook asks of the mic, and lets each test pick whether a
// dictation is already running.
const FAKE_AUDIO_MANAGER_SOURCE = `
export const calls = [];
export const state = { current: {} };
export default class FakeAudioManager {
  getState() {
    return state.current;
  }
  setCallbacks() {}
  setVoiceAgentRequested() {}
  setAssistantSelectionContext() {}
  setTranslationRequested() {}
  beginSelectionCapture() {}
  beginScreenContextCapture() {}
  shouldUseStreaming() {
    return false;
  }
  isSttConfigStale() {
    return false;
  }
  prepareMicCapture() {
    calls.push("prepare");
  }
  cancelPreparedMicCapture() {
    calls.push("cancel-prepared");
  }
  stopRecording() {
    calls.push("stop");
    return true;
  }
  cleanup() {}
  async startRecording() {
    calls.push("start");
    return false;
  }
}
`;

async function mountHarness(t, { interceptVoiceAgentToggle }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const handlers = {};
  const capture = (name) => (callback) => {
    handlers[name] = callback;
    return () => {};
  };
  const reported = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: capture("toggleDictation"),
        onToggleVoiceAgent: capture("toggleVoiceAgent"),
        onToggleTranslation: capture("toggleTranslation"),
        onStartDictation: capture("startDictation"),
        onPrepareDictation: capture("prepareDictation"),
        onCancelDictationPreparation: capture("cancelPreparation"),
        onStopDictation: capture("stopDictation"),
        dictationLifecycleStateChanged: (state, inputKind) =>
          reported.push(`${state}:${inputKind}`),
      },
    },
  });
  const container = installHookDom(t);
  // The start and stop paths wait on animation frames; resolve them at once.
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-voice-intercept-",
    mockModules: { "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE },
  });
  const fakeAudioManager = await vite.ssrLoadModule("/helpers/audioManager");
  fakeAudioManager.calls.length = 0;
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  let api;
  function Harness() {
    api = useAudioRecording(() => {}, { onDemoEvent: () => {}, interceptVoiceAgentToggle });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  reported.length = 0;
  return {
    handlers,
    reported,
    calls: fakeAudioManager.calls,
    state: fakeAudioManager.state,
    api: () => api,
  };
}

test("a voice conversation press cancels the dictation mic warm-up main sent ahead of it", async (t) => {
  let intercepted = 0;
  const harness = await mountHarness(t, {
    interceptVoiceAgentToggle: () => {
      intercepted += 1;
      return true;
    },
  });

  // Main sends prepare-dictation just before the toggle on every starting press.
  await React.act(async () => {
    void harness.handlers.prepareDictation({ inputKind: "assistant" });
    harness.handlers.toggleVoiceAgent();
  });

  assert.equal(intercepted, 1);
  assert.equal(harness.api().isPreparing, false);
  assert.ok(harness.calls.includes("cancel-prepared"));
  assert.ok(!harness.calls.includes("prepare"), "the warm-up never opens the dictation mic");
  assert.ok(!harness.calls.includes("start"));
  assert.deepEqual(harness.reported, ["preparing:assistant", "idle:dictation"]);
});

test("the voice hotkey still stops a running dictation instead of starting a voice session", async (t) => {
  let intercepted = 0;
  const harness = await mountHarness(t, {
    interceptVoiceAgentToggle: () => {
      intercepted += 1;
      return true;
    },
  });
  harness.state.current = { isRecording: true };

  await React.act(async () => {
    harness.handlers.toggleVoiceAgent();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(intercepted, 0);
  assert.ok(harness.calls.includes("stop"));
});

test("with voice conversation off the press starts a voice-assistant dictation as before", async (t) => {
  const harness = await mountHarness(t, { interceptVoiceAgentToggle: () => false });

  await React.act(async () => {
    harness.handlers.toggleVoiceAgent();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.ok(harness.calls.includes("start"));
  assert.ok(!harness.calls.includes("cancel-prepared"));
});
