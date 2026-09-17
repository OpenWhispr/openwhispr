const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Registers the real handler closures against a fake `this` (the scaffolding
// from agentDictationPillIpc.test.js) with the bearer state under test control
// and the binding file in a temporary userData directory, so the scope
// handlers run against the real accountScopeBinding.
const handlers = new Map();
const broadcasts = [];
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "account-scope-ipc-"));
let tokenState = { token: null, generation: 0 };

const electronStub = {
  app: {
    getPath: () => userDataDirectory,
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

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
        subscribe: () => () => {},
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: (channel, data) => broadcasts.push([channel, data]) };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const target = { sessionId: "test-session" };
  return new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
}

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(buildFakeThis());
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});

const getScope = () => handlers.get("get-active-account-scope")();
const setScope = (accountId, generation) =>
  handlers.get("set-active-account-scope")({}, accountId, generation);

test("no scope is readable before a session has been validated", async () => {
  tokenState = { token: "token-a", generation: 1 };
  assert.equal(await getScope(), null);
});

test("a validated scope is readable back and broadcast to every window", async () => {
  tokenState = { token: "token-a", generation: 1 };
  broadcasts.length = 0;
  assert.deepEqual(await setScope("account-a", 1), { success: true });
  assert.deepEqual(await getScope(), { accountId: "account-a", authGeneration: 1 });
  assert.deepEqual(broadcasts, [
    ["active-account-scope-changed", { accountId: "account-a", authGeneration: 1 }],
  ]);
});

test("a rotated bearer hides the scope until the session is validated again", async () => {
  tokenState = { token: "token-b", generation: 2 };
  assert.equal(await getScope(), null);
  await setScope("account-a", 2);
  assert.deepEqual(await getScope(), { accountId: "account-a", authGeneration: 2 });
});

test("a rejected scope request changes nothing and broadcasts nothing", async () => {
  tokenState = { token: "token-b", generation: 3 };
  broadcasts.length = 0;
  const result = await setScope("account-b", 2);
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
  assert.deepEqual(broadcasts, []);
});

test("a validated sign-out clears the scope and broadcasts the clearing", async () => {
  tokenState = { token: null, generation: 4 };
  broadcasts.length = 0;
  assert.deepEqual(await setScope(null, 4), { success: true });
  assert.equal(await getScope(), null);
  assert.deepEqual(broadcasts, [["active-account-scope-changed", null]]);
});
