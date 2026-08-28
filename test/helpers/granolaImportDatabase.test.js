const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-granola-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-granola-db-"));
  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

function granolaRow(key, overrides = {}) {
  return {
    clientNoteId: `00000000-0000-4000-8000-${key.repeat(12).slice(0, 12)}`,
    sourceFile: `granola:${key}`,
    title: `Meeting ${key}`,
    content: `Summary body ${key}`,
    transcript: null,
    participants: null,
    createdAt: "2024-05-01 10:00:00",
    ...overrides,
  };
}

test("importNotes inserts backdated meeting notes into the Imported folder", (t) => {
  const db = createDb(t);
  if (!db) return;

  const result = db.importNotes([granolaRow("a"), granolaRow("b")]);
  assert.equal(result.success, true);
  assert.equal(result.imported, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.noteIds.length, 2);

  const note = db.getNote(result.noteIds[0]);
  assert.equal(note.created_at, "2024-05-01 10:00:00");
  assert.equal(note.updated_at, "2024-05-01 10:00:00");
  assert.equal(note.note_type, "meeting");
  assert.equal(note.sync_status, "pending");
  assert.equal(note.source_file, "granola:a");
  assert.equal(note.space_id, db.getPrivateSpaceId());
  assert.equal(note.folder_id, result.folderId);

  const folder = db.getFolders().find((f) => f.id === result.folderId);
  assert.equal(folder.name, "Imported");
  db.db.close();
});

test("importNotes falls back to the current time when createdAt is null", (t) => {
  const db = createDb(t);
  if (!db) return;

  const result = db.importNotes([granolaRow("c", { createdAt: null })]);
  const note = db.getNote(result.noteIds[0]);
  assert.match(note.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  db.db.close();
});

test("importNotes is idempotent across re-runs", (t) => {
  const db = createDb(t);
  if (!db) return;

  const rows = [granolaRow("d"), granolaRow("e")];
  db.importNotes(rows);
  const rerun = db.importNotes(rows);
  assert.equal(rerun.imported, 0);
  assert.equal(rerun.skipped, 2);
  const count = db.db.prepare("SELECT COUNT(*) AS n FROM notes").get().n;
  assert.equal(count, 2);
  db.db.close();
});

test("importNotes handles a mixed batch of new and duplicate rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.importNotes([granolaRow("f")]);
  const result = db.importNotes([granolaRow("f"), granolaRow("1")]);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  db.db.close();
});

test("importNotes rows are searchable through FTS", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.importNotes([granolaRow("a", { title: "Quarterly Roadmap Review" })]);
  const hits = db.searchNotes("Roadmap");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "Quarterly Roadmap Review");
  db.db.close();
});

test("importNotes reuses an existing Imported folder", (t) => {
  const db = createDb(t);
  if (!db) return;

  const created = db.createFolder("Imported");
  const result = db.importNotes([granolaRow("a")]);
  assert.equal(result.folderId, created.folder.id);
  const folders = db.getFolders().filter((f) => f.name === "Imported");
  assert.equal(folders.length, 1);
  db.db.close();
});

test("getExistingClientNoteIds reports only ids already in the table", (t) => {
  const db = createDb(t);
  if (!db) return;

  const rowA = granolaRow("a");
  db.importNotes([rowA]);
  const existing = db.getExistingClientNoteIds([rowA.clientNoteId, granolaRow("b").clientNoteId]);
  assert.deepEqual(existing, [rowA.clientNoteId]);
  db.db.close();
});
