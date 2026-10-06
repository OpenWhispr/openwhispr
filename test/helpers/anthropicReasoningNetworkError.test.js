const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// process-anthropic-reasoning's catch block used to return the raw error
// message/messageKey only, so a network failure (proxyFetch rejecting before
// any HTTP response, e.g. DNS/TLS) reached the renderer as a bare, unclassified
// Error instead of a translatable PROVIDER_UNREACHABLE. This exercises the
// real handler closure against a stubbed Electron `net.fetch`, following the
// pattern in test/helpers/retryTranscriptionHandler.test.js.
const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

const handlers = new Map();
let fetchBehavior = async () => {
  throw new Error("net::ERR_INTERNET_DISCONNECTED");
};

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
  net: {
    fetch: async (...args) => fetchBehavior(...args),
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
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by this handler can be an inert stub.
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

function buildFakeThis() {
  const target = {
    sessionId: "test-session",
    environmentManager: {
      getAnthropicKey: () => "sk-ant-test-key",
    },
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let anthropicHandler;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(buildFakeThis());
  anthropicHandler = handlers.get("process-anthropic-reasoning");
  assert.ok(anthropicHandler, "process-anthropic-reasoning must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

// Electron's net.fetch rejects with a plain Error carrying the Chromium net
// error as its message and no code.
test("a network failure (net::ERR_INTERNET_DISCONNECTED) resolves classified instead of a bare error", async () => {
  fetchBehavior = async () => {
    throw new Error("net::ERR_INTERNET_DISCONNECTED");
  };

  const result = await anthropicHandler({ sender: {} }, "hello", "claude-sonnet-5", null, {});

  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_UNREACHABLE");
  assert.equal(result.messageKey, "providerErrors.unreachable");
  assert.equal(result.surface, "llm");
  assert.match(result.error, /Couldn't reach Anthropic/);
});

test("an Anthropic HTTP failure resolves with classified IPC fields", async () => {
  fetchBehavior = async () =>
    new Response(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      { status: 400, headers: { "request-id": "req_9" } }
    );

  const result = await anthropicHandler({ sender: {} }, "hello", "claude-sonnet-5", null, {});

  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_QUOTA_EXHAUSTED");
  assert.equal(result.messageKey, "providerErrors.quotaExhausted");
  assert.deepEqual(result.messageParams, { provider: "Anthropic" });
  assert.equal(result.settingsTarget, "llms");
  assert.equal(result.status, 400);
  assert.equal(result.technicalDetails.requestId, "req_9");
  assert.equal(result.error, "Your Anthropic account is out of credit.");
});

test("an already-classified failure (missing key) passes through unchanged", async () => {
  const noKeyThis = {
    sessionId: "test-session",
    environmentManager: { getAnthropicKey: () => "" },
  };
  const proxiedThis = new Proxy(noKeyThis, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
  const handlersForNoKey = new Map();
  const originalHandle = electronStub.ipcMain.handle;
  electronStub.ipcMain.handle = (channel, fn) => handlersForNoKey.set(channel, fn);
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(proxiedThis);
  electronStub.ipcMain.handle = originalHandle;

  const handler = handlersForNoKey.get("process-anthropic-reasoning");
  const result = await handler({ sender: {} }, "hello", "claude-sonnet-5", null, {});

  assert.equal(result.success, false);
  assert.equal(result.code, "API_KEY_MISSING");
  assert.equal(result.messageKey, "providerErrors.keyMissing");
});
