const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A minimal AudioManager stand-in whose startRecording() fails without ever
// invoking the onStateChange callback registered via setCallbacks — this
// mirrors the real failure path (mic-open rejection, permission denial,
// etc.), where only onError fires. reportLifecycle's own report inside
// performStartRecording, and its finally-block reset, are the only things
// this test exercises.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = { success: true };
  }
  getState() {
    return {};
  }
  setCallbacks() {}
  setVoiceAgentRequested(value) {
    this.voiceAgentRequested = value;
  }
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
    return false;
  }
}
`;

// Mounts useAudioRecording over the fake AudioManager and returns its API, the
// lifecycle reports made after mount, and the agent-recording listener.
async function mountRecording(t) {
  // t.after hooks run in registration order, so this unmount must be
  // registered before installBrowserGlobals/installHookDom's own cleanup —
  // otherwise window/document are already torn down when unmount runs.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const reported = [];
  const listeners = {};
  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        // The mount effect registers all seven of these unconditionally (or
        // via optional chaining); onToggleDictation in particular is called
        // without "?.", so it must exist even though these tests drive
        // startRecording() directly rather than through any of these events.
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        onAgentRecordingChanged: (callback) => {
          listeners.agentRecording = callback;
          return () => {};
        },
        dictationLifecycleStateChanged: (state) => reported.push(state),
      },
    },
  });
  const container = installHookDom(t);
  // The start path awaits two animation frames before opening the mic;
  // resolve them synchronously instead of riding out the 250ms/frame
  // fallback timeout twice in these tests.
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-preparing-reset-",
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

  // The mount effect reports its own "idle" reset; isolate the assertions to
  // what performStartRecording itself reports.
  reported.length = 0;
  return { api: () => api, reported, listeners };
}

test("a failed dictation start reports the lifecycle back to idle instead of sticking on preparing", async (t) => {
  const { api, reported } = await mountRecording(t);

  let started;
  await React.act(async () => {
    started = await api().startRecording();
  });

  assert.equal(started, false);
  assert.deepEqual(reported, ["preparing", "idle"]);
});

// A pill click or the pill menu starts dictation without main's hotkey guard;
// while the agent window records, both would hold the microphone.
test("no dictation starts while the agent window records", async (t) => {
  const { api, reported, listeners } = await mountRecording(t);

  listeners.agentRecording(true);
  let started;
  await React.act(async () => {
    started = await api().startRecording();
  });
  assert.equal(started, false);
  assert.deepEqual(reported, [], "nothing prepares");

  listeners.agentRecording(false);
  await React.act(async () => {
    await api().startRecording();
  });
  assert.deepEqual(reported, ["preparing", "idle"]);
});
