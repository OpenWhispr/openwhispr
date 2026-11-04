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

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
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
  target = {
    sessionId: "test-session",
    _autoLearnEnabled: false,
    textEditMonitor: null,
    selectionManager: null,
  };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  assert.ok(handlers.get("product-events-record-dictation"), "the dictation fact must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

// The dictation fact's IPC: main decides what counts as onboarding practice,
// whatever the renderer sends.
function recordDictation(onboardingActive, dictation) {
  const recorded = [];
  target.productEvents = { recordDictationCompleted: (fact) => recorded.push(fact) };
  target.windowManager =
    onboardingActive === undefined ? undefined : { isOnboardingActive: () => onboardingActive };
  handlers.get("product-events-record-dictation")({}, dictation);
  return recorded;
}

const DICTATION = { captureId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", words: 12, mode: "local" };

test("a dictation in the normal app is recorded as dictation", () => {
  assert.deepEqual(recordDictation(false, DICTATION), [{ ...DICTATION, practice: false }]);
});

test("a dictation while onboarding holds the app is practice, whatever the renderer says", () => {
  assert.deepEqual(recordDictation(true, { ...DICTATION, practice: false }), [
    { ...DICTATION, practice: true },
  ]);
});

test("a dictation main can't place in or out of onboarding counts as practice", () => {
  assert.deepEqual(recordDictation(undefined, DICTATION), [{ ...DICTATION, practice: true }]);
});
