const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { deferred } = require("./harness/deferred");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const probes = [];
const tokens = [];
let probeAnswer = async () => ({ success: true });
let tokenAnswer = async () => "token";
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "provider-connection-ipc-"));

const electronStub = {
  app: {
    getPath: () => userData,
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
    if (request === "./connectionCheckCache" || request === "./paidKeyCheck") {
      return originalLoad.call(this, request, parent, isMain);
    }
    if (request === "./providerConnectionTest") {
      const { describeCortiTokenFailure } = originalLoad.call(this, request, parent, isMain);
      return {
        describeCortiTokenFailure,
        testProviderConnection: (config, _fetch, runPaidCheck) => {
          probes.push(config);
          return probeAnswer(config, runPaidCheck);
        },
      };
    }
    if (request === "./cortiAuth") {
      return {
        getCortiToken: async (target) => {
          tokens.push(target);
          return tokenAnswer(target);
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
  fs.rmSync(userData, { recursive: true, force: true });
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

test("Tinfoil's paid key check runs once per key, across checks the cache keeps apart", async () => {
  let paid = 0;
  probeAnswer = (_config, runPaidCheck) =>
    runPaidCheck("tf-key", async () => {
      paid += 1;
      return { success: true };
    });
  for (const model of ["voxtral-small-24b", "gpt-oss-120b"]) {
    const config = { scope: "transcription", provider: "tinfoil", apiKey: "tf-key", model };
    assert.deepEqual(await check(config), { success: true });
  }
  assert.equal(paid, 1);
  const stored = fs.readFileSync(path.join(userData, "paid-key-checks.json"), "utf8");
  assert.doesNotMatch(stored, /tf-key/);
});

test("Corti's own refusal and its no-verdict failures reach the panel, never remembered", async () => {
  const corti = {
    scope: "transcription",
    provider: "corti",
    clientId: "corti-id-3",
    clientSecret: "corti-secret-3",
    environment: "eu",
    tenant: "",
  };
  const busy = Object.assign(new Error("Corti authentication failed: 503"), { status: 503 });
  tokenAnswer = async () => {
    throw busy;
  };
  try {
    const before = tokens.length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await check(corti);
      assert.equal(result.errorCode, "providerStatus");
      assert.equal(result.unverified, true);
    }
    assert.equal(tokens.length - before, 2, "no verdict is asked again");
    tokenAnswer = async () => {
      throw Object.assign(new Error("Corti authentication failed: 401"), { status: 401 });
    };
    const refusedFrom = tokens.length;
    assert.equal((await check(corti)).errorCode, "credentialsRejected");
    assert.equal((await check(corti)).errorCode, "credentialsRejected");
    assert.equal(tokens.length - refusedFrom, 2, "a refusal is asked again too");
  } finally {
    tokenAnswer = async () => "token";
  }
});
