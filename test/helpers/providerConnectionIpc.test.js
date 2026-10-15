const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { deferred } = require("./harness/deferred");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const probes = [];
const tokens = [];
let probeAnswer = async () => ({ success: true });

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
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
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

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./connectionCheckCache") {
      return originalLoad.call(this, request, parent, isMain);
    }
    if (request === "./providerConnectionTest") {
      return {
        testProviderConnection: (config) => {
          probes.push(config);
          return probeAnswer(config);
        },
      };
    }
    if (request === "./cortiAuth") {
      return {
        getCortiToken: async (target) => {
          tokens.push(target);
          return "token";
        },
      };
    }
    if (request.startsWith("./") || request.startsWith("../")) return anything();
  }
  return originalLoad.call(this, request, parent, isMain);
};

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(
    new Proxy({}, { get: (value, property) => (property in value ? value[property] : anything()) })
  );
  assert.ok(handlers.get("test-provider-connection"));
});

test.after(() => {
  Module._load = originalLoad;
});

const check = (config) => handlers.get("test-provider-connection")({}, config);

test("panels asking the same check share one request, and Connected is reused", async () => {
  const answer = deferred();
  probeAnswer = () => answer.promise;
  const config = { scope: "reasoning", provider: "openai", apiKey: "sk-shared", model: "m" };
  const before = probes.length;
  const pending = [check(config), check({ ...config })];
  answer.resolve({ success: true });
  assert.deepEqual(await Promise.all(pending), [{ success: true }, { success: true }]);
  assert.deepEqual(await check(config), { success: true });
  assert.equal(probes.length - before, 1);
});

test("a failure from the handler is never remembered", async () => {
  probeAnswer = async () => ({ success: false, errorCode: "credentialsRejected", status: 401 });
  const config = { scope: "reasoning", provider: "openai", apiKey: "sk-rejected" };
  const before = probes.length;
  await check(config);
  await check(config);
  assert.equal(probes.length - before, 2);
});

test("Corti's token request is shared and remembered the same way", async () => {
  const config = {
    scope: "transcription",
    provider: "corti",
    clientId: "corti-id",
    clientSecret: "corti-secret",
    environment: "eu",
    tenant: "",
  };
  assert.deepEqual(await Promise.all([check(config), check(config)]), [
    { success: true },
    { success: true },
  ]);
  assert.deepEqual(await check(config), { success: true });
  assert.deepEqual(tokens, [
    { environment: "eu", tenant: "base", clientId: "corti-id", clientSecret: "corti-secret" },
  ]);
  assert.equal(
    probes.some((probe) => probe.provider === "corti"),
    false
  );
});
