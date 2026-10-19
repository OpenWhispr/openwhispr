const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// open-settings-section takes the agent's open_settings destinations and every
// provider error target, such as Note Formatting from a note run's error toast.
const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const REAL_MODULES = new Set(["./settingsTargets", "./providerHttpErrors"]);
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

const opened = [];

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    windowManager: { openSettings: async (section) => opened.push(section) },
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.after(() => {
  Module._load = originalLoad;
});

test("open-settings-section opens agent and provider error destinations only", async () => {
  const open = handlers.get("open-settings-section");
  for (const section of [
    "llms",
    "speechToText",
    "noteFormatting",
    "privacyData",
    "integrations.connectors",
    "integrations.calendars",
  ]) {
    opened.length = 0;
    assert.deepEqual(await open({}, section), { success: true }, section);
    assert.deepEqual(opened, [section]);
  }

  opened.length = 0;
  assert.deepEqual(await open({}, "system"), { success: false });
  assert.deepEqual(opened, []);
});
