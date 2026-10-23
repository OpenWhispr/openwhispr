const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

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

const frameOf = (contents) => ({ sender: contents, senderFrame: contents.mainFrame });

function makeContents() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, sent: [], destroyed: false });
  contents.send = (channel) => contents.sent.push(channel);
  contents.isDestroyed = () => contents.destroyed;
  return contents;
}

function makeWindowManagerStub() {
  const calls = { lifecycle: [], agent: [] };
  const mainContents = makeContents();
  const stub = {
    mainWindow: { isDestroyed: () => false, webContents: mainContents },
    setDictationLifecycleState: (state) => {
      calls.lifecycle.push(state);
    },
    openAgentWindow: () => calls.agent.push(["open"]),
    agentWindow: {
      deliverCommand: (command) => {
        calls.agent.push(["command", command]);
        return true;
      },
    },
    hotkeyManager: {
      registered: null,
      registerSlot(slot, key, callback) {
        this.registered = { slot, key, callback };
        return { success: true };
      },
      unregisterSlot(slot) {
        calls.agent.push(["unregister", slot]);
        this.registered = null;
      },
    },
  };
  return { stub, calls, mainContents };
}

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(buildFakeThis());
});

test.after(() => {
  Module._load = originalLoad;
});

test("only the main renderer can change its window's input region", async () => {
  const { stub, mainContents } = makeWindowManagerStub();
  const regions = [];
  stub.setMainWindowInputRegion = async (region) => {
    regions.push(region);
    return true;
  };
  installWindowManager(stub);
  const handler = handlers.get("set-main-window-input-region");
  const region = { viewportWidth: 208, viewportHeight: 120, x: 156, y: 68, width: 40, height: 40 };
  assert.equal(await handler({ sender: mainContents }, region), true);
  assert.equal(handler({ sender: makeContents() }, null), null);
  assert.equal(handler({ sender: {} }, null), null);
  stub.mainWindow = null;
  assert.equal(handler({ sender: mainContents }, null), null);
  assert.deepEqual(regions, [region]);
});

test("lifecycle reports are accepted only from the dictation renderer", () => {
  const { stub, calls, mainContents } = makeWindowManagerStub();
  installWindowManager(stub);
  const lifecycleHandler = handlers.get("dictation-lifecycle-state-changed");

  assert.equal(lifecycleHandler({ sender: {} }, "recording", "take-1"), false);
  assert.deepEqual(calls.lifecycle, []);
  lifecycleHandler(frameOf(mainContents), "recording", "take-1");
  assert.deepEqual(calls.lifecycle, ["recording"]);
});

test("only the dictation window opens the agent window or hands it a wake-word command", async () => {
  const { stub, calls: allCalls, mainContents } = makeWindowManagerStub();
  const calls = allCalls.agent;
  installWindowManager(stub);
  const stranger = frameOf(makeContents());
  const subframe = { sender: mainContents, senderFrame: {} };
  const command = { text: "what's next", attachment: null, selectedContext: null };

  assert.equal(await handlers.get("open-agent-window")(stranger), false);
  assert.equal(await handlers.get("open-agent-window")(subframe), false);
  assert.equal(await handlers.get("agent-window-submit-command")(stranger, command), false);
  assert.deepEqual(calls, []);

  assert.equal(await handlers.get("open-agent-window")(frameOf(mainContents)), true);
  assert.equal(
    await handlers.get("agent-window-submit-command")(frameOf(mainContents), command),
    true
  );
  assert.deepEqual(calls, [["open"], ["command", command]]);
});

test("Esc reaches the window that registered it, and only that window takes it back", async () => {
  const { stub, calls: allCalls, mainContents } = makeWindowManagerStub();
  const calls = allCalls.agent;
  installWindowManager(stub);
  const agentContents = makeContents();

  await handlers.get("register-cancel-hotkey")(frameOf(agentContents), "Escape");
  stub.hotkeyManager.registered.callback();
  assert.deepEqual(agentContents.sent, ["cancel-hotkey-pressed"]);
  assert.deepEqual(mainContents.sent, []);

  assert.deepEqual(await handlers.get("unregister-cancel-hotkey")(frameOf(mainContents)), {
    success: false,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(await handlers.get("unregister-cancel-hotkey")(frameOf(agentContents)), {
    success: true,
  });
  assert.deepEqual(calls, [["unregister", "cancel"]]);

  // A window that is gone can't hold it either.
  await handlers.get("register-cancel-hotkey")(frameOf(agentContents), "Escape");
  agentContents.destroyed = true;
  stub.hotkeyManager.registered.callback();
  assert.deepEqual(agentContents.sent, ["cancel-hotkey-pressed"]);
  assert.deepEqual(await handlers.get("unregister-cancel-hotkey")(frameOf(mainContents)), {
    success: true,
  });
});

test("a window that reloads, crashes or closes while it holds Esc gives it back", async () => {
  const { stub, calls: allCalls } = makeWindowManagerStub();
  const calls = allCalls.agent;
  installWindowManager(stub);

  for (const leave of [
    (contents) => contents.emit("did-navigate", {}, "http://app/", 200, "OK"),
    (contents) => contents.emit("render-process-gone", {}, { reason: "crashed" }),
    (contents) => contents.emit("destroyed"),
  ]) {
    const contents = makeContents();
    await handlers.get("register-cancel-hotkey")(frameOf(contents), "Escape");
    // An in-page navigation (a footnote link) keeps the renderer, and Esc,
    // and so does one will-navigate blocks (a dropped file), which starts and
    // never commits.
    contents.emit("did-navigate-in-page", {}, "http://app/#note", true);
    contents.emit("did-start-navigation", {}, "file:///tmp/shot.png", false, true);
    assert.deepEqual(calls, []);
    leave(contents);
    assert.deepEqual(calls, [["unregister", "cancel"]]);
    calls.length = 0;
  }

  // Leaving after another window took Esc leaves that window's Esc alone.
  const first = makeContents();
  const second = makeContents();
  await handlers.get("register-cancel-hotkey")(frameOf(first), "Escape");
  await handlers.get("register-cancel-hotkey")(frameOf(second), "Escape");
  first.emit("destroyed");
  assert.deepEqual(calls, []);
});

for (const [navigation, id] of [
  ["blocked", 502],
  ["failed", 503],
]) {
  test(`a ${navigation} main-frame navigation retains conversation ownership`, async () => {
    target.databaseManager = {
      activeAccountId: null,
      getAgentConversation: (id) => ({ id, messages: [] }),
    };
    const first = makeContents();
    const peer = makeContents();
    const claim = handlers.get("claim-agent-conversation");
    assert.equal((await claim(frameOf(first), id, "first")).owned, true);
    first.emit("did-start-navigation", {}, "file:///missing", false, true);
    if (navigation === "failed") {
      first.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///missing", true);
    }
    assert.equal(
      (await claim(frameOf(peer), id, "peer")).owned,
      false,
      "a navigation that never committed leaves the current owner alive"
    );
    assert.equal(
      (await handlers.get("db-get-agent-conversation")(frameOf(peer), id)).has_active_turn,
      true
    );
    first.emit("destroyed");
  });
}

test("conversation recovery has one owner and releases on renderer loss or committed navigation", async () => {
  target.databaseManager = {
    activeAccountId: null,
    getAgentConversation: (id) => ({ id, messages: [] }),
  };
  const first = makeContents();
  const peer = makeContents();
  const claim = handlers.get("claim-agent-conversation");
  const release = handlers.get("release-agent-conversation");
  assert.equal(typeof claim, "function");
  assert.equal((await claim(frameOf(first), 501, "first")).owned, true);
  assert.equal(
    (await handlers.get("db-get-agent-conversation")(frameOf(peer), 501)).has_active_turn,
    true
  );
  assert.equal((await claim(frameOf(peer), 501, "peer")).owned, false);
  await release(frameOf(peer), 501, "first");
  assert.equal(
    (await claim(frameOf(peer), 501, "peer")).owned,
    false,
    "another renderer cannot release it"
  );
  first.emit("did-start-navigation", {}, "about:blank", false, false);
  assert.equal(
    (await claim(frameOf(peer), 501, "peer")).owned,
    false,
    "subframes cannot release it"
  );
  first.emit("did-frame-navigate", {}, "about:blank", 200, "OK", false, 1, 2);
  first.emit("did-navigate-in-page", {}, "file:///app#note", true);
  assert.equal(
    (await claim(frameOf(peer), 501, "peer")).owned,
    false,
    "subframe and same-document commits keep the owner"
  );
  first.emit("did-navigate", {}, "file:///app", 200, "OK");
  assert.equal(
    (await claim(frameOf(peer), 501, "peer")).owned,
    true,
    "reload permits interrupted recovery"
  );
  await release(frameOf(first), 501, "first");
  first.emit("did-navigate", {}, "file:///app", 200, "OK");
  assert.equal(
    (await claim(frameOf(first), 501, "first")).owned,
    false,
    "the previous owner cannot release the peer's claim"
  );
  peer.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal((await claim(frameOf(first), 501, "after-crash")).owned, true);
  first.emit("destroyed");
  assert.equal((await claim(frameOf(peer), 501, "after-close")).owned, true);
  await release(frameOf(peer), 501, "after-close");
  assert.equal(
    (await handlers.get("db-get-agent-conversation")(frameOf(peer), 501)).has_active_turn,
    false
  );
});
