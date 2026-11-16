const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: {} };
  return originalLoad.call(this, request, parent, isMain);
};
const DatabaseManager = require("../../src/helpers/database.js");
Module._load = originalLoad;

function createDatabase(t, { migrate = true, filename = ":memory:" } = {}) {
  const sqlite = new DatabaseSync(filename);
  t.after(() => {
    if (sqlite.isOpen) sqlite.close();
  });
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY, title TEXT, content TEXT, enhanced_content TEXT,
      space_id INTEGER, folder_id INTEGER, deleted_at TEXT, account_id TEXT,
      updated_at TEXT
    );
  `);
  sqlite.transaction = (callback) => () => {
    sqlite.exec("BEGIN");
    try {
      const result = callback();
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  };
  const manager = Object.create(DatabaseManager.prototype);
  manager.db = sqlite;
  if (migrate) manager._initVectorChangeJournal();
  return manager;
}

function acknowledgeAll(manager) {
  for (const change of manager.getPendingVectorChanges()) {
    manager.clearPendingVectorChange(change.note_id, change.revision);
  }
}

test("vector journal seeds existing notes once without reviving acknowledged work", (t) => {
  const manager = createDatabase(t, { migrate: false });
  manager.db.exec("INSERT INTO notes (id, title) VALUES (1, 'Existing')");
  assert.equal(typeof manager._initVectorChangeJournal, "function");
  manager._initVectorChangeJournal();
  assert.deepEqual(
    manager.getPendingVectorChanges().map((row) => row.note_id),
    [1]
  );
  acknowledgeAll(manager);
  manager._initVectorChangeJournal();
  assert.deepEqual(manager.getPendingVectorChanges(), []);
});

test("vector journal tracks raw insert, indexed field changes, and physical deletion", (t) => {
  const manager = createDatabase(t);
  manager.db.exec("INSERT INTO notes (id, title) VALUES (1, 'Imported')");
  assert.equal(manager.getPendingVectorChanges()[0].note_id, 1);
  acknowledgeAll(manager);
  for (const [field, value] of [
    ["title", "Renamed"],
    ["content", "Cloud edit"],
    ["enhanced_content", "Enhanced"],
    ["space_id", 2],
    ["folder_id", 3],
    ["deleted_at", "2026-09-21"],
    ["deleted_at", null],
  ]) {
    manager.db.prepare(`UPDATE notes SET ${field} = ? WHERE id = 1`).run(value);
    assert.equal(manager.getPendingVectorChanges()[0]?.note_id, 1, field);
    acknowledgeAll(manager);
  }
  manager.db.exec("DELETE FROM notes WHERE id = 1");
  assert.equal(manager.getPendingVectorChanges()[0].note_id, 1);
  assert.equal(manager.getNoteForVectorIndex(1), null);
});

test("vector journal skips irrelevant or unchanged field updates", (t) => {
  const manager = createDatabase(t);
  manager.db.exec("INSERT INTO notes (id, title) VALUES (1, 'Title')");
  acknowledgeAll(manager);
  manager.db.exec("UPDATE notes SET title = 'Title', updated_at = '2026-09-21' WHERE id = 1");
  assert.deepEqual(manager.getPendingVectorChanges(), []);
});

test("vector journal acknowledgements cannot erase newer edits or reused note ids", (t) => {
  const manager = createDatabase(t);
  manager.db.exec("INSERT INTO notes (id, title) VALUES (1, 'Original')");
  const initial = manager.getPendingVectorChanges()[0];
  manager.db.exec("UPDATE notes SET content = 'Concurrent edit' WHERE id = 1");
  assert.equal(manager.clearPendingVectorChange(1, initial.revision).changes, 0);
  const edited = manager.getPendingVectorChanges()[0];
  assert.ok(edited.revision > initial.revision);
  acknowledgeAll(manager);
  manager.db.exec("DELETE FROM notes WHERE id = 1");
  acknowledgeAll(manager);
  manager.db.exec("INSERT INTO notes (id, title) VALUES (1, 'Reinserted')");
  assert.equal(manager.clearPendingVectorChange(1, edited.revision).changes, 0);
  assert.ok(manager.getPendingVectorChanges()[0].revision > edited.revision);
});

test("vector journal changes roll back with note writes", (t) => {
  const manager = createDatabase(t);
  assert.throws(
    () =>
      manager.db.transaction(() => {
        manager.db.exec("INSERT INTO notes (id, title) VALUES (1, 'Aborted')");
        throw new Error("aborted");
      })(),
    /aborted/
  );
  assert.deepEqual(manager.getPendingVectorChanges(), []);
  assert.equal(manager.getNoteForVectorIndex(1), null);
});

test("full reindex refreshes revisions and preserves deletion tombstones", (t) => {
  const manager = createDatabase(t);
  manager.db.exec("INSERT INTO notes (id, title) VALUES (1, 'First'), (2, 'Second')");
  const previous = manager.getPendingVectorChanges()[0];
  manager.db.exec("DELETE FROM notes WHERE id = 2");
  manager.enqueueAllVectorChanges();
  assert.deepEqual(
    manager
      .getPendingVectorChanges()
      .map((row) => row.note_id)
      .sort(),
    [1, 2]
  );
  assert.equal(manager.getPendingVectorChanges(1).length, 1);
  assert.equal(manager.clearPendingVectorChange(1, previous.revision).changes, 0);
  assert.equal(
    manager.clearPendingVectorChange(
      1,
      manager.getPendingVectorChanges().find((row) => row.note_id === 1).revision
    ).changes,
    1
  );
});

test("indexing reads current notes across accounts including soft deletion", (t) => {
  const manager = createDatabase(t);
  manager.activeAccountId = "first-account";
  manager.db.exec(
    "INSERT INTO notes (id, title, account_id, deleted_at) VALUES (1, 'Other', 'other-account', '2026-09-21')"
  );
  const note = manager.getNoteForVectorIndex(1);
  assert.equal(note.title, "Other");
  assert.equal(note.deleted_at, "2026-09-21");
});

test("pending deletions and acknowledged revisions survive database restart", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-vector-journal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "notes.db");
  const manager = createDatabase(t, { filename });
  manager.db.exec("INSERT INTO notes (id, title) VALUES (1, 'Keep'), (2, 'Remove')");
  const originalRevision = manager.getPendingVectorChanges()[0].revision;
  acknowledgeAll(manager);
  manager.db.exec("DELETE FROM notes WHERE id = 2");
  const pendingDeletion = manager.getPendingVectorChanges()[0];
  manager.db.close();

  const reopened = createDatabase(t, { filename });
  assert.deepEqual(reopened.getPendingVectorChanges(), [pendingDeletion]);
  acknowledgeAll(reopened);
  reopened.db.exec("UPDATE notes SET title = 'Edited after restart' WHERE id = 1");
  assert.ok(reopened.getPendingVectorChanges()[0].revision > pendingDeletion.revision);
  assert.equal(reopened.clearPendingVectorChange(1, originalRevision).changes, 0);
  reopened.db.close();
});

test("pending changes can be paged by revision cursor so parked rows are skipped", (t) => {
  const manager = createDatabase(t);
  manager.db.exec("INSERT INTO notes (id, title) VALUES (1, 'A'), (2, 'B'), (3, 'C')");
  const [first, second, third] = manager.getPendingVectorChanges();
  assert.deepEqual(manager.getPendingVectorChanges(50, first.revision), [second, third]);
  assert.deepEqual(manager.getPendingVectorChanges(1, first.revision), [second]);
  assert.deepEqual(manager.getPendingVectorChanges(50, third.revision), []);
  manager.db.exec("UPDATE notes SET title = 'A2' WHERE id = 1");
  const [edited] = manager.getPendingVectorChanges(50, third.revision);
  assert.equal(edited.note_id, 1);
  assert.ok(edited.revision > third.revision);
});
