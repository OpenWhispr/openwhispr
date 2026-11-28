const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// #3323: a running app told it was removed from the workspace that managed this
// device records the removal and relaunches into the launch wipe; the notice
// that wipe leaves goes to the control panel alone.
const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const REAL_MODULES = new Set(["./localDataWipe"]);
const originalLoad = Module._load;
const handlers = new Map();
// The handlers read it as they are set up, before any test makes its own.
const setupData = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-removal-wipe-setup-"));
let userData = setupData;

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

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (
    parent?.filename === handlersModulePath &&
    !REAL_MODULES.has(request) &&
    (request.startsWith("./") || request.startsWith("../"))
  ) {
    return anything();
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

const controlPanel = {};
let IPCHandlers;

test.before(() => {
  delete require.cache[handlersModulePath];
  IPCHandlers = require(handlersModulePath);
  const target = { windowManager: { controlPanelWindow: { webContents: controlPanel } } };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-removal-wipe-"));
});

test.afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(setupData, { recursive: true, force: true });
});

const removal = { workspaceId: "workspace-1", removedAt: "2026-11-12T10:00:00.000Z" };
const record = () =>
  JSON.parse(fs.readFileSync(path.join(userData, "local-data-wipe.json"), "utf8"));

test("a removal is recorded for the launch wipe, and the app relaunches once", () => {
  let relaunches = 0;
  const app = { relaunchApp: async () => relaunches++ };
  assert.equal(IPCHandlers.prototype._wipeForWorkspaceRemoval.call(app, removal), true);
  assert.equal(IPCHandlers.prototype._wipeForWorkspaceRemoval.call(app, removal), true);
  assert.equal(relaunches, 1);
  assert.deepEqual(record().pendingRemoval, removal);
});

test("a removal the app can't record is reported again, and nothing relaunches until it is", () => {
  let relaunches = 0;
  const app = { relaunchApp: async () => relaunches++ };
  const folder = userData;
  userData = path.join(folder, "not-a-folder");
  fs.writeFileSync(userData, "");
  try {
    assert.equal(IPCHandlers.prototype._wipeForWorkspaceRemoval.call(app, removal), false);
    assert.equal(relaunches, 0);
  } finally {
    userData = folder;
  }
  assert.equal(IPCHandlers.prototype._wipeForWorkspaceRemoval.call(app, removal), true);
  assert.equal(relaunches, 1);
});

test("the removal's notice goes to the control panel alone, once", async () => {
  fs.writeFileSync(
    path.join(userData, "local-data-wipe.json"),
    JSON.stringify({ token: "T1", notice: "workspace-removal" })
  );
  const take = handlers.get("take-local-data-wipe-notice");
  assert.equal(await take({ sender: {} }), null);
  assert.equal(await take({ sender: controlPanel }), "workspace-removal");
  assert.equal(await take({ sender: controlPanel }), null);
  assert.deepEqual(record(), { token: "T1" });
});
