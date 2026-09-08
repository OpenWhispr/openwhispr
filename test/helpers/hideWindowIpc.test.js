// The renderer's hide-window IPC is what ends the pill's zoop: App.jsx
// releases the held Agent mark when it settles, so a resolve that did NOT
// actually hide would play the leaf->ring morph on a pill still on screen —
// the exact bug Task 8 exists to prevent. hideDictationPanel refuses while
// the Assistant panel owns the window, so this handler must not resolve on
// that path.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

const handlers = new Map();

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
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  globalShortcut: {
    register: () => true,
    unregister: () => undefined,
    isRegistered: () => false,
    unregisterAll: () => undefined,
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

// Registration only stores closures, so every manager this handler does not
// touch can be an inert stub (same pattern as hotkeyModeInfoIpc.test.js).
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

const hideCalls = [];
let hideResult = true;

function buildFakeThis() {
  const windowManager = new Proxy(
    {
      hideDictationPanel: (options) => {
        hideCalls.push(options);
        return hideResult;
      },
    },
    { get: (t, prop) => (prop in t ? t[prop] : anything()) }
  );
  return new Proxy({ windowManager }, { get: (t, prop) => (prop in t ? t[prop] : anything()) });
}

let hideWindowHandler;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(buildFakeThis());
  hideWindowHandler = handlers.get("hide-window");
  assert.ok(hideWindowHandler, "hide-window must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

test("the renderer's hide-window skips the zoop — the renderer has already played it", async () => {
  hideCalls.length = 0;
  hideResult = true;
  await hideWindowHandler({ sender: {} });
  assert.deepEqual(hideCalls, [{ animate: false }]);
});

test("a refused hide rejects instead of resolving, so no caller can read it as done", async () => {
  hideCalls.length = 0;
  hideResult = false;
  await assert.rejects(
    async () => hideWindowHandler({ sender: {} }),
    /refused/,
    "resolving here would release the held Agent mark with the pill still on screen"
  );
});
