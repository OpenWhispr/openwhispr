const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
let pendingNotice = null;

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

const noticeStub = {
  take: () => {
    const taken = pendingNotice;
    pendingNotice = null;
    return taken;
  },
};

Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }
  if (parent?.filename === handlersModulePath && request === "./gpuPackMigrationNotice") {
    return noticeStub;
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

function fakeWindow({ destroyed = false } = {}) {
  const sent = [];
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: { send: (channel) => sent.push(channel) },
  };
}

let target;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = { _gpuPackNoticeWindow: Ctor.prototype._gpuPackNoticeWindow };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.after(() => {
  Module._load = originalLoad;
});

function setUp({ startedMinimized, controlPanel, destroyed = [] }) {
  pendingNotice = { packs: ["CUDA whisper"] };
  const mainWindow = fakeWindow({ destroyed: destroyed.includes("main") });
  const controlPanelWindow = controlPanel
    ? fakeWindow({ destroyed: destroyed.includes("controlPanel") })
    : null;
  target.windowManager = {
    startedMinimized,
    mainWindow,
    controlPanelWindow,
    setOnboardingActive: () => true,
  };
  const take = (window) =>
    handlers.get("take-gpu-pack-migration-notice")({ sender: window.webContents });
  const setOnboardingActive = (active) => handlers.get("onboarding-set-active")({}, active);
  return { mainWindow, controlPanelWindow, take, setOnboardingActive };
}

test("on a normal start only the control panel can take the notice", () => {
  const { mainWindow, controlPanelWindow, take, setOnboardingActive } = setUp({
    startedMinimized: false,
    controlPanel: true,
  });

  setOnboardingActive(false);
  assert.deepEqual(mainWindow.sent, [], "the pill is never told to take it");
  assert.equal(take(mainWindow), null);
  assert.deepEqual(take(controlPanelWindow), { packs: ["CUDA whisper"] });
  assert.equal(take(controlPanelWindow), null, "taken once");
});

test("before a normal start's control panel exists the pill can't take the notice", () => {
  const { mainWindow, take, setOnboardingActive } = setUp({
    startedMinimized: false,
    controlPanel: false,
  });

  setOnboardingActive(false);
  assert.deepEqual(mainWindow.sent, []);
  assert.equal(take(mainWindow), null);
  assert.deepEqual(pendingNotice, { packs: ["CUDA whisper"] }, "kept for the control panel");
});

test("started to the tray, the pill is told once the normal app is up", () => {
  const { mainWindow, take, setOnboardingActive } = setUp({
    startedMinimized: true,
    controlPanel: false,
  });

  setOnboardingActive(true);
  assert.deepEqual(mainWindow.sent, [], "not while onboarding hides the pill");
  setOnboardingActive(false);
  assert.deepEqual(mainWindow.sent, ["gpu-pack-migration-notice-ready"]);

  assert.equal(take(fakeWindow()), null, "an overlay window can't take it");
  assert.deepEqual(take(mainWindow), { packs: ["CUDA whisper"] });
});

test("started to the tray, a control panel opened since takes the notice instead", () => {
  const { mainWindow, controlPanelWindow, take, setOnboardingActive } = setUp({
    startedMinimized: true,
    controlPanel: true,
  });

  setOnboardingActive(false);
  assert.deepEqual(mainWindow.sent, []);
  assert.equal(take(mainWindow), null);
  assert.deepEqual(take(controlPanelWindow), { packs: ["CUDA whisper"] });
});

test("a destroyed control panel hands the notice back to a tray start's pill", () => {
  const { mainWindow, controlPanelWindow, take, setOnboardingActive } = setUp({
    startedMinimized: true,
    controlPanel: true,
    destroyed: ["controlPanel"],
  });

  setOnboardingActive(false);
  assert.deepEqual(mainWindow.sent, ["gpu-pack-migration-notice-ready"]);
  assert.equal(take(controlPanelWindow), null);
  assert.deepEqual(take(mainWindow), { packs: ["CUDA whisper"] });
});

test("destroyed windows are never told about or handed the notice", () => {
  const { mainWindow, controlPanelWindow, take, setOnboardingActive } = setUp({
    startedMinimized: true,
    controlPanel: true,
    destroyed: ["controlPanel", "main"],
  });

  setOnboardingActive(false);
  assert.deepEqual(mainWindow.sent, []);
  assert.equal(take(controlPanelWindow), null);
  assert.equal(take(mainWindow), null);
  assert.deepEqual(pendingNotice, { packs: ["CUDA whisper"] }, "kept for a later window");
});
