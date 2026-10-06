const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// The renderer decides whether to summarise a note in parts from this one
// number (#2142 part 3), so the handler must hand back the same ceiling
// runInference would size the window against.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const ceilingCalls = [];

const modelManagerStub = {
  default: {
    modelsDir: "/models",
    ensureInitialized() {},
    findModelById: (id) =>
      id === "qwen3.5-9b-q4_k_m"
        ? { model: { id, name: "Qwen3.5 9B", fileName: "qwen.gguf" }, provider: { id: "qwen" } }
        : null,
    async contextCeiling(modelInfo, modelPath) {
      ceilingCalls.push({ modelId: modelInfo.model.id, modelPath });
      return { ceiling: 32256, reason: "memory-bound", cacheRamMiB: 512 };
    },
  },
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
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" }),
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
  if (parent?.filename === handlersModulePath && request === "./modelManagerBridge") {
    return modelManagerStub;
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

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const fakeThis = new Proxy(
    { sessionId: "test-session" },
    { get: (value, property) => (property in value ? value[property] : anything()) }
  );
  Ctor.prototype.setupHandlers.call(fakeThis);
});

test.after(() => {
  Module._load = originalLoad;
});

const budgetFor = (modelId) => handlers.get("get-local-context-budget")({}, modelId);

test("returns the ceiling and display name for a bundled model", async () => {
  assert.deepEqual(await budgetFor("qwen3.5-9b-q4_k_m"), {
    success: true,
    maxContextTokens: 32256,
    modelName: "Qwen3.5 9B",
  });
  assert.deepEqual(ceilingCalls, [
    { modelId: "qwen3.5-9b-q4_k_m", modelPath: "/models/qwen.gguf" },
  ]);
});

test("an unknown model is a plain failure, not a throw", async () => {
  const result = await budgetFor("nope");
  assert.equal(result.success, false);
  assert.match(result.error, /not found/);
});
