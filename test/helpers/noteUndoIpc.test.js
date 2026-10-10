const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Registers the real handler closures against a fake `this` (the scaffolding
// from semanticSearchIpc.test.js): an Undo must reach every window, the search
// index and the note's mirror file like any other note write.
const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const sent = [];

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
      return [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, data) => sent.push([channel, data]) },
        },
      ];
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

const RESTORED = { id: 7, title: "Before the assistant" };
let undoResult;
let createAckResult;
const effects = { vectors: 0, mirrored: [] };

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const target = {
    notifyVectorChanges: () => effects.vectors++,
    _asyncMirrorWrite: (note) => effects.mirrored.push(note),
    databaseManager: {
      undoNoteUpdate: () => undoResult,
      acknowledgeNoteCreate: () => createAckResult,
    },
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

const undo = async () => {
  const result = await handlers.get("db-undo-note-update")(null, "token");
  await new Promise((resolve) => setImmediate(resolve));
  return result;
};

test("an Undo broadcasts the restored note, wakes the index and rewrites the mirror", async () => {
  undoResult = { success: true, note: RESTORED };
  assert.equal((await undo()).success, true);
  assert.deepEqual(sent, [["note-updated", RESTORED]]);
  assert.equal(effects.vectors, 1);
  assert.deepEqual(effects.mirrored, [RESTORED]);
});

test("a refused Undo writes nothing anywhere", async () => {
  sent.length = 0;
  effects.vectors = 0;
  effects.mirrored = [];
  undoResult = { success: false, error: "note_changed" };
  assert.equal((await undo()).success, false);
  assert.deepEqual(sent, []);
  assert.equal(effects.vectors, 0);
  assert.deepEqual(effects.mirrored, []);
});

test("a create acknowledgement that reconciles text refreshes editors and the index", async () => {
  sent.length = 0;
  effects.vectors = 0;
  createAckResult = { success: true, outcome: "synced", note: { id: 7, content: "" } };
  const result = await handlers.get("db-acknowledge-note-create")(null, 7, {}, "cloud-7");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result, createAckResult);
  assert.deepEqual(sent, [["note-synced", createAckResult.note]]);
  assert.equal(effects.vectors, 1);
});

test("an identity-rejected create acknowledgement does not broadcast", async () => {
  sent.length = 0;
  effects.vectors = 0;
  createAckResult = { success: true, outcome: "identity-changed" };
  await handlers.get("db-acknowledge-note-create")(null, 7, {}, "old-account-cloud");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, []);
  assert.equal(effects.vectors, 0);
});
