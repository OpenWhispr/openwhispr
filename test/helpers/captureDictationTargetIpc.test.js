const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { deferred } = require("./harness/deferred");

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
  target = { textEditMonitor: null, selectionManager: null };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  assert.ok(
    handlers.get("capture-dictation-target"),
    "capture-dictation-target must be registered"
  );
});

test.after(() => {
  Module._load = originalLoad;
});

// Recording start awaits this handler (#1944): a stalled Linux AT-SPI or Windows
// window probe must not hold it, while the macOS frontmost-PID read still must.
test("capture-dictation-target awaits the target PID but not the window probe", async () => {
  const probe = deferred();
  const pidRead = deferred();
  let probeStarted = false;
  target.selectionManager = {
    captureTarget: () => {
      probeStarted = true;
      return probe.promise;
    },
  };
  target.textEditMonitor = { captureTargetPid: () => pidRead.promise };

  let settled = false;
  const pending = handlers
    .get("capture-dictation-target")()
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeStarted, true);
  assert.equal(settled, false, "the handler must wait for the target PID");

  pidRead.resolve(4242);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, "the handler must not wait for the window probe");
  probe.resolve(null);
  assert.deepEqual(await pending, { success: true, pid: 4242 });
});
