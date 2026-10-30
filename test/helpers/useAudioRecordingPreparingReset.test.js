const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const sourceRoot = process.env.OPENWHISPR_TEST_SOURCE || path.resolve(__dirname, "../..");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals, installHookDom } = require(
  path.join(sourceRoot, "test/lib/rendererTestHarness")
);

// Load only the real arbitration classes; no Electron window or native helper runs.
function arbitration() {
  const load = (name) => {
    const filename = path.join(sourceRoot, "src/helpers", `${name}.js`);
    const loaded = new Module(filename, module);
    loaded.require = (request) => {
      if (["./dictationLifecycle", "./ipcSender"].includes(request))
        return require(path.join(sourceRoot, "src/helpers", request));
      if (request === "url") return require(request);
      if (request === "./dragManager")
        return class {
          async stopWindowDrag() {}
        };
      return { NOTIFICATION_WINDOW_CONFIG: { width: 400, height: 100 } };
    };
    loaded._compile(fs.readFileSync(filename, "utf8"), filename);
    return loaded.exports;
  };
  const WindowManager = load("windowManager");
  const { AgentWindowManager } = load("agentWindowManager");
  const main = Object.assign(Object.create(WindowManager.prototype), {
    _dictationLifecycleState: "idle",
    _dictationAttempt: null,
    _isDictatingToggle: false,
  });
  const agent = new AgentWindowManager(main);
  const frame = {};
  agent.window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  main.agentWindow = agent;
  const sender = { sender: agent.window.webContents, senderFrame: frame };
  return { main, agent, sender };
}

const FAKE_AUDIO_MANAGER_SOURCE = `
import { PreparedMicCapture } from "/helpers/preparedMicCapture.js";
export default class FakeAudioManager {
  constructor() {
    globalThis.__ownershipFixture.manager = this;
    this.sttConfig = { success: true };
    this.state = {};
    this.preparedMicCapture = new PreparedMicCapture({
      setTimer: (fn) => { globalThis.__ownershipFixture.expire = fn; return 1; },
      clearTimer() {},
      onActiveChange: () => this.emit(),
    });
  }
  getState() { return { ...this.state, isPreparing: this.preparedMicCapture.active }; }
  emit() { this.callbacks?.onStateChange(this.getState()); }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  setVoiceAgentRequested(value) { this.voiceAgentRequested = value; }
  setTranslationRequested(value) { this.translationRequested = value; }
  shouldUseStreaming() { return false; }
  isSttConfigStale() { return false; }
  getRecordingAudioLevel() { return 0; }
  prepareMicCapture() {
    const fixture = globalThis.__ownershipFixture;
    if (!fixture.prepare) return;
    return this.preparedMicCapture.prepare(() => fixture.prepare());
  }
  cancelPreparedMicCapture() { this.preparedMicCapture.cancel(); }
  cancelRecording() { this.state.isRecording = false; this.emit(); return true; }
  stopRecording() { return this.cancelRecording(); }
  cleanup() { this.cancelPreparedMicCapture(); this.cancelRecording(); this.callbacks = null; }
  async startRecording() {
    const fixture = globalThis.__ownershipFixture;
    fixture.starts++;
    await this.preparedMicCapture.take();
    if (fixture.open) await fixture.open();
    this.state.isRecording = fixture.startResult;
    if (fixture.startResult) this.emit();
    return fixture.startResult;
  }
}
`;

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Mounts useAudioRecording over the fake AudioManager and returns its API, the
// lifecycle reports made after mount, and the agent-recording listener.
async function mountRecording(t, fixture = {}) {
  fixture.starts = 0;
  fixture.startResult ??= false;
  globalThis.__ownershipFixture = fixture;
  t.after(() => delete globalThis.__ownershipFixture);
  const { main, agent, sender } = arbitration();
  // t.after hooks run in registration order, so this unmount must be
  // registered before installBrowserGlobals/installHookDom's own cleanup —
  // otherwise window/document are already torn down when unmount runs.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const reported = [];
  const listeners = {};
  const listen = (name) => (callback) => {
    listeners[name] = callback;
    return () => {};
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        // The mount effect registers all seven of these unconditionally (or
        // via optional chaining); onToggleDictation in particular is called
        // without "?.", so it must exist even though these tests drive
        // startRecording() directly rather than through any of these events.
        onToggleDictation: listen("ToggleDictation"),
        onToggleVoiceAgent: listen("ToggleVoiceAgent"),
        onToggleTranslation: listen("ToggleTranslation"),
        onStartDictation: listen("StartDictation"),
        onPrepareDictation: listen("PrepareDictation"),
        onCancelDictationPreparation: listen("CancelDictationPreparation"),
        onStopDictation: listen("StopDictation"),
        onAgentRecordingChanged: (callback) => {
          listeners.agentRecording = callback;
          return () => {};
        },
        dictationLifecycleStateChanged:
          fixture.admission ??
          (async (state, attempt) => {
            reported.push(state);
            // 9425 used a one-way send. Transporting its real state mutation must
            // not fail the base probe merely because that method returned void.
            const result = main.setDictationLifecycleState(state, attempt);
            return result === undefined ? true : result;
          }),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-preparing-reset-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/visualFrame": "export const waitForVisualFrames = async () => {};",
      "/services/ReasoningService":
        "export default class ReasoningService { static cancelAllRequests() {} }",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  let api;
  const toast = () => {};
  const options = { onDemoEvent: () => {} };
  function Harness() {
    api = useAudioRecording(toast, options);
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  // The mount effect reports its own "idle" reset; isolate the assertions to
  // what performStartRecording itself reports.
  reported.length = 0;
  main.mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel, value) => listeners.agentRecording?.(value),
    },
  };
  return {
    api: () => api,
    vite,
    reported,
    listeners,
    fixture,
    main,
    agent,
    admitAgent: (id = "agent-1") => agent.setVoiceState(sender, "recording", id),
    releaseAgent: (id = "agent-1") => agent.setVoiceState(sender, "idle", id),
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
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

test("main admits only one microphone owner in either start order", () => {
  for (const first of ["dictation", "agent"]) {
    const { main, agent, sender } = arbitration();
    if (first === "dictation") {
      main.setDictationLifecycleState("preparing", "d1");
      agent.setVoiceState(sender, "recording", "a1");
    } else {
      agent.setVoiceState(sender, "recording", "a1");
      main.setDictationLifecycleState("preparing", "d1");
    }
    assert.equal(main.isDictationActive() && agent.isRecording(), false, first);
  }
});

test("stale lifecycle releases cannot revoke a newer owner", () => {
  const { main, agent, sender } = arbitration();
  main.setDictationLifecycleState("preparing", "d1");
  main.setDictationLifecycleState("idle", "d1");
  main.setDictationLifecycleState("preparing", "d2");
  main.setDictationLifecycleState("idle", "d1");
  assert.equal(main.isDictationActive(), true);
  main.setDictationLifecycleState("idle", "d2");
  agent.setVoiceState(sender, "recording", "a1");
  agent.setVoiceState(sender, "idle", "a1");
  agent.setVoiceState(sender, "recording", "a2");
  agent.setVoiceState(sender, "idle", "a1");
  assert.equal(agent.isRecording(), true);
});

test("a held dictation target reserves ownership before real AudioManager capture", async (t) => {
  const h = await mountRecording(t, { startResult: true });
  const { installMicCaptureGlobals } = require(
    path.join(sourceRoot, "test/lib/rendererTestHarness")
  );
  installMicCaptureGlobals(t);
  const target = deferred();
  globalThis.window.electronAPI.captureDictationTarget = () => target.promise;
  const { default: AudioManager } = await h.vite.ssrLoadModule("/helpers/audioManager.js");
  let captures = 0;
  let recorders = 0;
  let stopped = 0;
  const open = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = (...args) => {
    captures++;
    return open(...args).then((stream) => {
      stream.getTracks()[0].stop = () => {
        stopped++;
      };
      return stream;
    });
  };
  const real = Object.assign(Object.create(AudioManager.prototype), {
    isRecordingAllowedByPolicy: () => true,
    _beginActivationCapture: async () => true,
    preparedMicCapture: { take: async () => null, cancel() {}, active: false },
    getAudioConstraints: async () => ({ audio: true }),
    _startPcmTap: () => null,
    micStreamHold: { acquireClone: () => null, adoptAndClone: (stream) => stream, drop() {} },
    acquireHealthyMicStream: async (stream) => stream,
    _startRecordingSpool: () => null,
    createBatchRecorder: (stream) => {
      recorders++;
      real.mediaRecorder = { state: "recording", stream };
    },
    stopRecording: () => {
      real.mediaRecorder.state = "inactive";
      return true;
    },
    micRecovery: { stop() {} },
    getActiveStreamingProviderName: () => null,
    getStreamingProvider: () => ({}),
    beginMicRecovery: async () => {},
    onStateChange: (state) => h.fixture.manager.callbacks.onStateChange(state),
  });
  h.fixture.manager.startRecording = () => real.startRecording();
  h.fixture.manager.getState = () => real.getState();
  h.fixture.manager.cancelRecording = () => {
    real.isRecording = false;
    clearInterval(real._silenceInterval);
    return true;
  };
  h.fixture.manager.cleanup = () => real.cleanup();
  t.after(() => clearInterval(real._silenceInterval));
  let starting;
  await React.act(async () => {
    starting = h.api().startRecording();
  });
  const admittedAgent = h.admitAgent();
  await React.act(async () => {
    target.resolve();
    await starting;
  });
  assert.equal(captures, 1);
  assert.equal(recorders, 1);
  assert.equal(real.isRecording, true);
  assert.equal(admittedAgent && real.isRecording, false, "two recording pipelines must not run");
  await h.unmount();
  assert.equal(stopped, 1, "unmount stops tracks before the deferred recorder event");
  assert.equal(h.main.isDictationActive(), false);
});

for (const phase of ["admission", "target", "microphone"]) {
  test(`cancelling dictation during ${phase} abandons capture and releases ownership`, async (t) => {
    const gate = deferred();
    const fixture = { startResult: true };
    let h;
    if (phase === "admission")
      fixture.admission = async (state, attempt) => {
        const result = h.main.setDictationLifecycleState(state, attempt);
        if (state === "preparing") await gate.promise;
        return result === undefined ? true : result;
      };
    if (phase === "microphone") fixture.open = () => gate.promise;
    h = await mountRecording(t, fixture);
    if (phase === "target")
      globalThis.window.electronAPI.captureDictationTarget = () => gate.promise;
    let starting;
    await React.act(async () => {
      starting = h.api().startRecording();
      await flush();
    });
    await React.act(async () => {
      await h.api().cancelRecording();
    });
    if (phase === "microphone") assert.equal(h.admitAgent(), false, "opening still owns the mic");
    await React.act(async () => {
      gate.resolve();
      await starting;
    });
    assert.equal(h.fixture.manager.getState().isRecording ?? false, false);
    assert.equal(h.main.isDictationActive(), false);
    assert.equal(h.admitAgent(), true);
  });
}

for (const admission of [
  undefined,
  async () => false,
  async () => {
    throw Error("unavailable");
  },
]) {
  test("missing, refused or rejected admission never opens dictation capture", async (t) => {
    const h = await mountRecording(t, { startResult: true });
    globalThis.window.electronAPI.dictationLifecycleStateChanged = admission;
    await React.act(async () => {
      await h.api().startRecording();
    });
    assert.equal(h.fixture.starts, 0);
  });
}

test("an abandoned prewarm keeps ownership until its held microphone is disposed", async (t) => {
  const media = deferred();
  let stopped = 0;
  const h = await mountRecording(t, { prepare: () => media.promise });
  let preparing;
  await React.act(async () => {
    preparing = h.listeners.PrepareDictation();
    await flush();
  });
  await React.act(async () => {
    h.listeners.CancelDictationPreparation();
  });
  assert.equal(h.admitAgent(), false);
  await React.act(async () => {
    media.resolve({
      stream: {
        getTracks: () => [
          {
            stop: () => {
              stopped++;
            },
          },
        ],
      },
    });
    await preparing;
  });
  assert.equal(stopped, 1);
  assert.equal(h.main.isDictationActive(), false);
  assert.equal(h.admitAgent(), true);
});

test("prewarm transfers one admitted capture to PTT and an unused capture expires", async (t) => {
  let opens = 0;
  const h = await mountRecording(t, {
    startResult: true,
    prepare: async () => {
      opens++;
      return { stream: { getTracks: () => [{ stop() {} }] } };
    },
  });
  await React.act(async () => {
    await h.listeners.PrepareDictation();
  });
  assert.equal(h.main.isDictationActive(), true);
  await React.act(async () => {
    await h.api().startRecording();
  });
  assert.equal(opens, 1);
  assert.equal(h.fixture.manager.getState().isRecording, true);
  await React.act(async () => {
    await h.api().cancelRecording();
  });
  await React.act(async () => {
    await h.listeners.PrepareDictation();
  });
  assert.equal(h.main.isDictationActive(), true);
  await React.act(async () => {
    h.fixture.expire();
  });
  assert.equal(h.main.isDictationActive(), false);
});

test("PTT release during microphone opening stops the take and frees ownership", async (t) => {
  const mic = deferred();
  const h = await mountRecording(t, { startResult: true, open: () => mic.promise });
  let starting;
  await React.act(async () => {
    starting = h.api().startRecording();
    await flush();
  });
  await React.act(async () => {
    await h.api().stopRecording();
  });
  await React.act(async () => {
    mic.resolve();
    await starting;
  });
  assert.equal(h.fixture.manager.getState().isRecording, false);
  assert.equal(h.main.isDictationActive(), false);
});

test("Agent ownership refuses dictation even before its broadcast is received", async (t) => {
  const h = await mountRecording(t, { startResult: true });
  h.listeners.agentRecording = () => {};
  assert.equal(h.admitAgent(), true);
  await React.act(async () => {
    await h.api().startRecording();
  });
  assert.equal(h.fixture.starts, 0);
  assert.equal(h.main.isDictationActive(), false);
});
