const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Registers the real handler closures against a fake `this` (the scaffolding
// from granolaImportIpc.test.js) so the sync-notification-preferences adapter
// runs its real code path into a recording meeting detection engine.
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

const applied = [];
let target;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  // Mirrors the constructor's initial detector-gating state.
  target = {
    meetingProcessDetection: true,
    windowManager: { notificationPrefs: {} },
    meetingDetectionEngine: { setPreferences: (prefs) => applied.push(prefs) },
  };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.after(() => {
  Module._load = originalLoad;
});

const sync = (prefs) => handlers.get("sync-notification-preferences")({}, prefs);

const ENABLED_SNAPSHOT = {
  notificationsEnabled: true,
  notifyMeetingDetection: true,
  notifyCalendarReminders: true,
  meetingProcessDetection: true,
};

test("the saved snapshot drives both detectors", async () => {
  applied.length = 0;
  await sync({ ...ENABLED_SNAPSHOT, meetingProcessDetection: false });
  assert.equal(target.meetingProcessDetection, false);
  assert.deepEqual(applied, [{ audioDetection: true, processDetection: false }]);

  applied.length = 0;
  await sync(ENABLED_SNAPSHOT);
  assert.deepEqual(applied, [{ audioDetection: true, processDetection: true }]);

  applied.length = 0;
  await sync({ ...ENABLED_SNAPSHOT, notifyMeetingDetection: false });
  assert.deepEqual(applied, [{ audioDetection: false, processDetection: false }]);
});

test("a partial update re-derives from the retained state", async () => {
  await sync(ENABLED_SNAPSHOT);
  applied.length = 0;
  await sync({ notificationsEnabled: false });
  assert.deepEqual(applied, [{ audioDetection: false, processDetection: false }]);
  assert.equal(target.windowManager.notificationPrefs.notifyMeetingDetection, true);
});

test("a non-object payload is rejected without touching the detectors", async () => {
  applied.length = 0;
  assert.deepEqual(await sync(null), { success: false, error: "Invalid preferences" });
  assert.deepEqual(applied, []);
});
