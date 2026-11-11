const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
// Loaded before this file's Electron stub: the real database for the scope test below.
const { createDb } = require("./harness/db.js");

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
let databaseCalls = { searchNotes: [], getNoteIdsInScope: [] };
const fakeDatabase = {
  searchNotes: (...args) => {
    databaseCalls.searchNotes.push(args);
    return [KEYWORD_NOTE];
  },
  getNoteIdsInScope: (...args) => {
    databaseCalls.getNoteIdsInScope.push(args);
    return [1, 2];
  },
  getNote: (id) => ({ id, title: "Semantic" }),
  saveNote: () => ({ success: true, note: { id: 7, title: "Saved" } }),
};

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = {
    getSemanticSearch: () => lifecycle,
    notifyVectorChanges: Ctor.prototype.notifyVectorChanges,
    databaseManager: fakeDatabase,
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

test("semantic search filters by every id given", async () => {
  databaseCalls = { searchNotes: [], getNoteIdsInScope: [] };
  const filters = [];
  lifecycle = {
    search: async (_query, _limit, filter) => {
      filters.push(filter);
      return [
        { noteId: 9, score: 0.99 },
        { noteId: 2, score: 0.9 },
      ];
    },
  };
  const results = await handlers.get("db-semantic-search-notes")(
    null,
    "query",
    5,
    null,
    null,
    [1, 2, 6]
  );
  assert.deepEqual(filters, [{ must: [{ key: "space_id", match: { any: [1, 2, 6] } }] }]);
  // The keyword leg and SQLite's check of each vector hit get the same ids.
  assert.deepEqual(databaseCalls.searchNotes, [["query", 10, null, null, [1, 2, 6]]]);
  assert.deepEqual(databaseCalls.getNoteIdsInScope, [[null, null, [9, 2], [1, 2, 6]]]);
  assert.deepEqual(results.map((note) => note.id).sort(), [1, 2]);

  // A container inside the scope narrows it further, never widens it.
  filters.length = 0;
  await handlers.get("db-semantic-search-notes")(null, "query", 5, 2, null, [1, 2]);
  assert.deepEqual(filters, [
    {
      must: [
        { key: "space_id", match: { value: 2 } },
        { key: "space_id", match: { any: [1, 2] } },
      ],
    },
  ]);
});

test("an empty or malformed scope reads nothing", async () => {
  databaseCalls = { searchNotes: [], getNoteIdsInScope: [] };
  let searched = 0;
  lifecycle = {
    search: async () => {
      searched++;
      return [{ noteId: 2, score: 0.9 }];
    },
  };
  const search = (spaceIds) =>
    handlers.get("db-semantic-search-notes")(null, "query", 5, null, null, spaceIds);
  assert.deepEqual(await search([]), []);
  assert.deepEqual(await search("1,2"), []);
  assert.deepEqual(await search(["1"]), []);
  assert.equal(searched, 0);
  assert.deepEqual(databaseCalls.searchNotes, []);
});

test("a note moved out of scope after indexing is still filtered out", async (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  db.setActiveWorkspaceScope({ activeWorkspaceId: "ws-a", defaultWorkspaceId: "ws-a" });
  const privateA = db.getPrivateSpaceId();
  const privateB = db.getPrivateSpaceId("ws-b");
  const save = (title) =>
    db.saveNote(title, "The pricing tiers", "personal", null, null, null, privateA).note;
  const moved = save("Moved pricing plan");
  const stays = save("Kept pricing plan");
  // Both indexed while in workspace A's Private.
  for (const change of db.getPendingVectorChanges(100)) {
    db.clearPendingVectorChange(change.note_id, change.revision);
  }

  assert.equal(db.updateNote(moved.id, { space_id: privateB }).success, true);
  // The move is journaled, so the index catches up on its next drain…
  assert.ok(db.getPendingVectorChanges(100).some((change) => change.note_id === moved.id));
  // …but until then its payload still names A's Private, and Qdrant returns it.
  lifecycle = {
    search: async () => [
      { noteId: moved.id, score: 0.95 },
      { noteId: stays.id, score: 0.9 },
    ],
  };
  target.databaseManager = db;
  t.after(() => {
    target.databaseManager = fakeDatabase;
  });
  const search = (spaceIds) =>
    handlers.get("db-semantic-search-notes")(null, "pricing", 5, null, null, spaceIds);

  assert.deepEqual(
    (await search([privateA])).map((note) => note.id),
    [stays.id]
  );
  // In workspace B the moved note is found, by its keywords, though its vector says A.
  assert.deepEqual(
    (await search([privateB])).map((note) => note.id),
    [moved.id]
  );
});

test("keyword search reads nothing for a malformed scope, never everything", async () => {
  databaseCalls = { searchNotes: [], getNoteIdsInScope: [] };
  const search = (spaceIds) =>
    handlers.get("db-search-notes")(null, "query", 5, null, null, spaceIds);
  await search([1, 2]);
  await search(null);
  await search("1,2");
  await search([1, "2"]);
  assert.deepEqual(
    databaseCalls.searchNotes.map((args) => args.at(-1)),
    [[1, 2], null, [], []]
  );
});
