const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Captures every ipcMain.handle/on registration so the registered handler
// closures can be invoked directly against a fake `this`, mirroring the
// scaffolding in test/helpers/retryTranscriptionHandler.test.js.
const handlers = new Map();
const onHandlers = new Map();

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => onHandlers.set(channel, fn),
    removeHandler: () => {},
  },
  net: {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
    }),
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

// Kept installed for the whole file: some helpers are require()d lazily at
// handler invocation time, not at module load.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./cortiTranscription") {
      return { transcribeAudio: async () => ({ text: "corti text" }) };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async () => ({ text: "tinfoil text", model: "tinfoil-model" }),
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by the pill handlers can be an inert stub.
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

// `target` stays a plain object (not the Proxy) so tests can reassign
// `target.windowManager` between cases and have the already-registered
// handler closures observe the swap on their next invocation — they read
// `this.windowManager` fresh each call, they don't capture it at registration.
let target;
function buildFakeThis() {
  target = {
    sessionId: "test-session",
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

function installWindowManager(stub) {
  target.windowManager = stub;
}

function makeWindowManagerStub() {
  const calls = { toggle: 0, cancel: 0, lifecycle: [], levels: [] };
  const mainContents = {};
  const pillContents = {};
  const stub = {
    mainWindow: { isDestroyed: () => false, webContents: mainContents },
    agentDictationPillWindow: { isDestroyed: () => false, webContents: pillContents },
    getAgentDictationPillState: () => ({
      lifecycle: "idle",
      interactive: true,
      horizontalDirection: "left",
    }),
    sendToggleDictation: () => {
      calls.toggle += 1;
    },
    sendCancelActiveDictation: () => {
      calls.cancel += 1;
    },
    setDictationLifecycleState: (state, kind) => {
      calls.lifecycle.push([state, kind]);
    },
    setDictationAudioLevel: (level) => {
      calls.levels.push(level);
    },
    resizeAgentDictationPillToContent: () => ({ success: true }),
    setAgentDictationPillInteractivity: () => undefined,
  };
  return { stub, calls, mainContents, pillContents };
}

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(buildFakeThis());
  assert.ok(
    handlers.get("toggle-agent-panel-dictation"),
    "toggle-agent-panel-dictation must be registered"
  );
  assert.ok(
    handlers.get("cancel-agent-panel-dictation"),
    "cancel-agent-panel-dictation must be registered"
  );
  assert.ok(
    handlers.get("get-agent-dictation-pill-state"),
    "get-agent-dictation-pill-state must be registered"
  );
  assert.ok(
    handlers.get("resize-agent-dictation-pill-to-content"),
    "resize-agent-dictation-pill-to-content must be registered"
  );
  assert.ok(
    handlers.get("set-agent-dictation-pill-interactivity"),
    "set-agent-dictation-pill-interactivity must be registered"
  );
  assert.ok(
    onHandlers.get("dictation-lifecycle-state-changed"),
    "dictation-lifecycle-state-changed must be registered"
  );
  assert.ok(
    onHandlers.get("dictation-audio-level-changed"),
    "dictation-audio-level-changed must be registered"
  );
});

test.after(() => {
  Module._load = originalLoad;
});

test("pill-scoped handlers reject foreign senders", async () => {
  const { stub, calls } = makeWindowManagerStub();
  installWindowManager(stub);
  const stranger = { sender: {} };

  assert.deepEqual(await handlers.get("toggle-agent-panel-dictation")(stranger), {
    success: false,
  });
  assert.deepEqual(await handlers.get("cancel-agent-panel-dictation")(stranger), {
    success: false,
  });
  assert.deepEqual(await handlers.get("get-agent-dictation-pill-state")(stranger), {
    lifecycle: "idle",
    interactive: false,
    horizontalDirection: "left",
  });
  assert.deepEqual(await handlers.get("resize-agent-dictation-pill-to-content")(stranger, 240), {
    success: false,
  });
  assert.deepEqual(await handlers.get("set-agent-dictation-pill-interactivity")(stranger, true), {
    success: false,
  });
  assert.equal(calls.toggle, 0);
  assert.equal(calls.cancel, 0);
});

test("a stale pill click cannot toggle or cancel a capture it does not own", async () => {
  const { stub, calls, pillContents } = makeWindowManagerStub();
  stub.getAgentDictationPillState = () => ({
    lifecycle: "idle",
    interactive: false,
    horizontalDirection: "left",
  });
  installWindowManager(stub);
  const pillEvent = { sender: pillContents };

  assert.deepEqual(await handlers.get("toggle-agent-panel-dictation")(pillEvent), {
    success: false,
  });
  assert.deepEqual(await handlers.get("cancel-agent-panel-dictation")(pillEvent), {
    success: false,
  });
  assert.equal(calls.toggle, 0);
  assert.equal(calls.cancel, 0);
});

test("an interactive pill click reaches the dictation toggle and cancel", async () => {
  const { stub, calls, pillContents } = makeWindowManagerStub();
  installWindowManager(stub);
  const pillEvent = { sender: pillContents };

  assert.deepEqual(await handlers.get("toggle-agent-panel-dictation")(pillEvent), {
    success: true,
  });
  assert.deepEqual(await handlers.get("cancel-agent-panel-dictation")(pillEvent), {
    success: true,
  });
  assert.equal(calls.toggle, 1);
  assert.equal(calls.cancel, 1);
});

test("audio levels are accepted only from the dictation renderer", () => {
  const { stub, calls, mainContents } = makeWindowManagerStub();
  installWindowManager(stub);
  const levelHandler = onHandlers.get("dictation-audio-level-changed");

  levelHandler({ sender: {} }, 0.5);
  assert.deepEqual(calls.levels, []);
  levelHandler({ sender: mainContents }, 0.5);
  assert.deepEqual(calls.levels, [0.5]);
});

test("lifecycle reports are accepted only from the dictation renderer", () => {
  const { stub, calls, mainContents } = makeWindowManagerStub();
  installWindowManager(stub);
  const lifecycleHandler = onHandlers.get("dictation-lifecycle-state-changed");

  lifecycleHandler({ sender: {} }, "recording", "dictation");
  assert.deepEqual(calls.lifecycle, []);
  lifecycleHandler({ sender: mainContents }, "recording", "dictation");
  assert.deepEqual(calls.lifecycle, [["recording", "dictation"]]);
});

// Bonus: the third `ipcMain.on` handler added alongside the two above shares
// the same dictation-renderer sender gate.
test("the final-transcript relay is accepted only from the dictation renderer", () => {
  const { stub, mainContents } = makeWindowManagerStub();
  const shown = [];
  stub.showAgentDictationFinalTranscript = (text) => shown.push(text);
  installWindowManager(stub);
  const finalTranscriptHandler = onHandlers.get("show-agent-dictation-final-transcript");
  assert.ok(finalTranscriptHandler, "show-agent-dictation-final-transcript must be registered");

  finalTranscriptHandler({ sender: {} }, "hello world");
  assert.deepEqual(shown, []);
  finalTranscriptHandler({ sender: mainContents }, "hello world");
  assert.deepEqual(shown, ["hello world"]);
});
