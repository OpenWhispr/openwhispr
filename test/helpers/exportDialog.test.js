const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
let saveDialogOptions;

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
  dialog: {
    showSaveDialog: async (options) => {
      saveDialogOptions = options;
      return { canceled: true, filePath: "" };
    },
  },
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

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    databaseManager: {
      getNote: () => ({
        id: 1,
        title: "Team sync",
        transcript: JSON.stringify([{ text: "Hello", start: 0, end: 1 }]),
      }),
    },
    _buildSpeakerMappings: () => ({}),
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.beforeEach(() => {
  saveDialogOptions = undefined;
});

test.after(() => {
  Module._load = originalLoad;
});

test("Markdown transcript export limits the save dialog to Markdown files", async () => {
  const result = await handlers.get("export-transcript")({}, 1, "md");

  assert.deepEqual(saveDialogOptions, {
    defaultPath: "Team sync.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  assert.deepEqual(result, { success: false });
});

for (const [format, name] of [
  ["md", "Markdown"],
  ["txt", "Text"],
]) {
  test(`${name} note export limits the save dialog to ${name} files`, async () => {
    const result = await handlers.get("export-note")({}, 1, format);

    assert.deepEqual(saveDialogOptions, {
      defaultPath: `Team sync.${format}`,
      filters: [{ name, extensions: [format] }],
    });
    assert.deepEqual(result, { success: false });
  });
}
