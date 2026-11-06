const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-server-sync-ipc-"));

const MODEL = "qwen3.5-4b-q4_k_m";
const CLEANUP_MODEL = "qwen3.5-2b-q4_k_m";
// One entry per running llama-server, by the model it holds.
const modelManager = {
  loaded: [],
  stopped: [],
  keepResident: null,
  stopServersNotNeeded: async (shouldStop) => {
    for (const modelId of modelManager.loaded) {
      if (shouldStop(modelId)) modelManager.stopped.push(modelId);
    }
  },
  setKeepResident: (keepResident) => {
    modelManager.keepResident = keepResident;
  },
};

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

Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }
  if (parent?.filename === handlersModulePath && request === "./modelManagerBridge") {
    return { default: modelManager };
  }
  return originalLoad.call(this, request, parent, isMain);
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

let target;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = { signedIn: false, envKeys: [] };
  target._syncStartupEnv = (setVars, clearVars) => {
    target.envKeys = [...Object.keys(setVars), ...clearVars];
  };
  target._hasActiveAccountScope = () => target.signedIn;
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  assert.ok(handlers.get("sync-startup-preferences"), "sync handler must be registered");
});

test.after(() => {
  target.metaActivation?.dispose();
  Module._load = originalLoad;
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});

function sync({ loaded, signedIn = false, policySettled = true, ...scopes }) {
  modelManager.loaded = Array.isArray(loaded) ? loaded : [loaded];
  modelManager.stopped = [];
  target.signedIn = signedIn;
  return handlers.get("sync-startup-preferences")(
    {},
    {
      useLocalWhisper: false,
      useCleanupModel: true,
      cleanupMode: "openwhispr",
      useDictationAgent: true,
      dictationAgentMode: "openwhispr",
      noteFormattingMode: "openwhispr",
      chatAgentMode: "openwhispr",
      useDictationTranslation: false,
      translationMode: "openwhispr",
      policySettled,
      ...scopes,
    }
  );
}

test("a window sync keeps the server while another scope still needs its model", async () => {
  await sync({ loaded: MODEL, chatAgentMode: "local", chatAgentModel: MODEL });
  assert.deepEqual(modelManager.stopped, []);
});

test("a window sync stops the server once no scope needs its model", async () => {
  await sync({ loaded: MODEL, chatAgentMode: "local", chatAgentModel: "gemma-4-e2b" });
  assert.deepEqual(modelManager.stopped, [MODEL]);
});

test("with two servers, a sync stops only the one whose model no scope needs", async () => {
  await sync({
    loaded: [CLEANUP_MODEL, MODEL],
    cleanupMode: "local",
    cleanupModel: CLEANUP_MODEL,
    chatAgentMode: "local",
    chatAgentModel: "gemma-4-e2b",
  });
  assert.deepEqual(modelManager.stopped, [MODEL]);
});

test("a signed-in window waits for its workspace policy before touching the server", async () => {
  await sync({ loaded: MODEL, signedIn: true, policySettled: false });
  assert.deepEqual(modelManager.stopped, []);
  assert.equal(target.envKeys.includes("CLEANUP_PROVIDER"), false, "no pre-warm change either");

  await sync({ loaded: MODEL, signedIn: true, policySettled: true });
  assert.deepEqual(modelManager.stopped, [MODEL]);
});

test("signed out, the policy never loads, so an unresolved policy does not block the stop", async () => {
  await sync({ loaded: MODEL, signedIn: false, policySettled: false });
  assert.deepEqual(modelManager.stopped, [MODEL]);
});

test("Keep model loaded applies before the workspace policy settles", async () => {
  await sync({ loaded: MODEL, signedIn: true, policySettled: false, keepLocalModelLoaded: true });
  assert.equal(modelManager.keepResident, true);

  await sync({ loaded: MODEL, signedIn: true, policySettled: false });
  assert.equal(modelManager.keepResident, false, "missing means off");
});
