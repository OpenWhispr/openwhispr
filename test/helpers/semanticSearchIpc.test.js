const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Registers the real handler closures against a fake `this` (the scaffolding
// from granolaImportIpc.test.js) so the semantic-search handlers run their real
// code paths against a scripted lifecycle owner and database.
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

const KEYWORD_NOTE = { id: 1, title: "Keyword" };
let lifecycle = null;
let target;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = {
    getSemanticSearch: () => lifecycle,
    notifyVectorChanges: Ctor.prototype.notifyVectorChanges,
    databaseManager: {
      searchNotes: () => [KEYWORD_NOTE],
      getNoteIdsInScope: () => [1, 2],
      getNote: (id) => ({ id, title: "Semantic" }),
      saveNote: () => ({ success: true, note: { id: 7, title: "Saved" } }),
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

const search = () => handlers.get("db-semantic-search-notes")(null, "query", 5, 4);

test("keyword results serve while no semantic search owner is composed", async () => {
  lifecycle = null;
  assert.deepEqual(await search(), [KEYWORD_NOTE]);
});

test("a cold index answers with keyword results after delegating warmup", async () => {
  let requests = 0;
  lifecycle = {
    search: async () => {
      requests++;
      return null;
    },
  };
  assert.deepEqual(await search(), [KEYWORD_NOTE]);
  assert.equal(requests, 1);
});

test("a warm index fuses vector hits and drops vectors outside the SQLite scope", async () => {
  lifecycle = {
    search: async () => [
      { noteId: 9, score: 0.99 },
      { noteId: 2, score: 0.9 },
    ],
  };
  const results = await search();
  assert.deepEqual(results.map((note) => note.id).sort(), [1, 2]);
});

test("a note save wakes the semantic index through the single poke", async () => {
  let pokes = 0;
  lifecycle = { notifyChanges: () => pokes++ };
  const result = await handlers.get("db-save-note")(null, "Saved", "body");
  assert.equal(result.success, true);
  assert.equal(pokes, 1);
});

test("a note save with no semantic search owner composed is harmless", async () => {
  lifecycle = null;
  const result = await handlers.get("db-save-note")(null, "Saved", "body");
  assert.equal(result.success, true);
});
