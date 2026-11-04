const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// startStreamingRecording() reports recording as soon as frames flow, then
// stays pending on the provider connect. A test releases it with finishStart().
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = { success: true };
    this.callbacks = {};
    this.state = {};
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
    return true;
  }
  isSttConfigStale() {
    return false;
  }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  cleanup() {}
  warmupStreamingConnection() {}
  getRecordingAudioLevel() {
    return null;
  }
  report(state) {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }
  startStreamingRecording() {
    return new Promise((resolve) => {
      this.finishStart = resolve;
      globalThis.__startOnStart?.(this);
    });
  }
  stopStreamingRecording() {
    this.report({ isRecording: false, isProcessing: false, isStreaming: false });
    return Promise.resolve(true);
  }
  cancelStreamingRecording() {
    this.report({ isRecording: false, isProcessing: true, isStreaming: false });
    return Promise.resolve(true);
  }
}
`;

const FAKE_CUES_SOURCE = `
export const playStartCue = async () => {
  globalThis.__startEvents.push("start");
};
export const playStopCue = async () => {
  globalThis.__startEvents.push("stop");
};
export const resumeContextIfNeeded = async () => null;
`;

const RECORDING = { isRecording: true, isProcessing: false, isStreaming: true };
const IDLE = { isRecording: false, isProcessing: false, isStreaming: false };

async function mountHook(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const noopDispose = () => () => {};
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
        dictationLifecycleStateChanged: () => {},
        pauseMediaPlayback: () => globalThis.__startEvents.push("pause"),
        resumeMediaPlayback: () => globalThis.__startEvents.push("resume"),
        registerCancelHotkey: () => globalThis.__startEvents.push("register"),
        unregisterCancelHotkey: () => globalThis.__startEvents.push("unregister"),
      },
    },
  });
  const container = installHookDom(t);
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  globalThis.__startEvents = [];
  globalThis.__startOnStart = null;
  t.after(() => {
    delete globalThis.__startEvents;
    delete globalThis.__startOnStart;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-start-effects-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/dictationCues": FAKE_CUES_SOURCE,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ pauseMediaOnDictation: true });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  // Stable identities: the hook rebuilds its AudioManager when these change.
  const toast = () => {};
  const options = { onDemoEvent: () => {} };
  const hook = {};
  function Harness() {
    hook.api = useAudioRecording(toast, options);
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  return hook;
}

async function settle() {
  await React.act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}

const STARTED = ["pause", "register", "start"];

test("cue, media pause and Escape act when recording begins, not when the connect finishes", async (t) => {
  const hook = await mountHook(t);
  let activeManager;
  globalThis.__startOnStart = (manager) => {
    activeManager = manager;
    manager.report(RECORDING);
    // Mic status reports repeat the recording state while the connect is pending.
    manager.report({ ...RECORDING, micCaptureStatus: "active" });
  };

  let started;
  await React.act(async () => {
    started = hook.api.startRecording();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await settle();
  assert.deepEqual(globalThis.__startEvents, STARTED, "must not wait for the connect");

  await React.act(async () => {
    activeManager.finishStart(true);
    await started;
  });
  assert.deepEqual(globalThis.__startEvents, STARTED, "must act once");
});

test("a streaming start that falls back to batch cues once and stays paused with Escape held", async (t) => {
  const hook = await mountHook(t);
  globalThis.__startOnStart = (manager) => {
    manager.report(RECORDING);
    manager.report(IDLE);
    manager.report({ isRecording: true, isProcessing: false, isStreaming: false });
    manager.finishStart(true);
  };

  await React.act(async () => {
    await hook.api.startRecording();
  });
  assert.deepEqual(globalThis.__startEvents, [
    ...STARTED,
    "unregister",
    "resume",
    "pause",
    "register",
  ]);
});

test("a start that never begins recording touches nothing", async (t) => {
  const hook = await mountHook(t);
  globalThis.__startOnStart = (manager) => manager.finishStart(false);

  await React.act(async () => {
    await hook.api.startRecording();
  });
  assert.deepEqual(globalThis.__startEvents, []);
});

test("a connect that fails after recording began resumes media and releases Escape", async (t) => {
  const hook = await mountHook(t);
  globalThis.__startOnStart = (manager) => {
    manager.report(RECORDING);
    manager.report(IDLE);
    manager.finishStart(false);
  };

  await React.act(async () => {
    await hook.api.startRecording();
  });
  assert.deepEqual(globalThis.__startEvents, [...STARTED, "unregister", "resume"]);
});

test("a stop pressed before recording begins never pauses media or holds Escape", async (t) => {
  const hook = await mountHook(t);
  globalThis.__startOnStart = (manager) => {
    hook.api.stopRecording();
    manager.report(RECORDING);
    manager.finishStart(true);
  };

  await React.act(async () => {
    await hook.api.startRecording();
  });
  await settle();
  const events = globalThis.__startEvents;
  for (const unwanted of STARTED) assert.equal(events.includes(unwanted), false, unwanted);
  assert.equal(events.includes("stop"), true);
});

test("a stop during the connect resumes media and releases Escape", async (t) => {
  const hook = await mountHook(t);
  globalThis.__startOnStart = (manager) => {
    manager.report(RECORDING);
    hook.api.stopRecording();
    manager.finishStart(true);
  };

  await React.act(async () => {
    await hook.api.startRecording();
  });
  await settle();
  const events = globalThis.__startEvents;
  assert.deepEqual(events.slice(0, 3), STARTED);
  assert.equal(events.includes("stop"), true);
  assert.equal(events.at(-1), "resume");
  assert.equal(events.at(-2), "unregister");
});

test("Escape during the connect cancels, resumes media and releases the hotkey", async (t) => {
  const hook = await mountHook(t);
  let activeManager;
  globalThis.__startOnStart = (manager) => {
    activeManager = manager;
    manager.report(RECORDING);
  };

  let started;
  await React.act(async () => {
    started = hook.api.startRecording();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await settle();
  await React.act(async () => {
    await hook.api.cancelRecording();
    activeManager.finishStart(false);
    await started;
  });
  const events = globalThis.__startEvents;
  assert.deepEqual(events.slice(0, 3), STARTED);
  assert.equal(events.includes("unregister"), true);
  assert.equal(events.at(-1), "resume");
  assert.equal(events.filter((event) => event === "register").length, 1);
});

test("recording state outside a start, such as mic recovery, changes nothing", async (t) => {
  const hook = await mountHook(t);
  let activeManager;
  globalThis.__startOnStart = (manager) => {
    activeManager = manager;
    manager.report(RECORDING);
    manager.finishStart(true);
  };
  await React.act(async () => {
    await hook.api.startRecording();
  });
  globalThis.__startEvents.length = 0;

  await React.act(async () => {
    activeManager.report(RECORDING);
    activeManager.report(IDLE);
    activeManager.report(RECORDING);
  });
  assert.deepEqual(globalThis.__startEvents, ["unregister", "resume"]);
});
