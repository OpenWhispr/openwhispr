const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-notes-owner-db-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-notes-owner-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  try {
    const database = new DatabaseManager();
    database.setActiveAccountId("test-account");
    return database;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

let nextSpaceId = 0;

function createTestTeamSpace(db, name) {
  const maxOrder = db.db.prepare("SELECT MAX(sort_order) AS max_order FROM spaces").get();
  const result = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, ?)"
    )
    .run(`test-owner-space-${++nextSpaceId}`, name, (maxOrder?.max_order ?? 0) + 1);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(result.lastInsertRowid, "test-account");
  return db.getSpace(result.lastInsertRowid);
}

function cloudNote(overrides = {}) {
  return {
    id: "cloud-1",
    client_note_id: "client-1",
    title: "Quarterly plan",
    content: "body",
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-02T10:00:00.000Z",
    ...overrides,
  };
}

test("owner_user_id migration is idempotent across launches", (t) => {
  const db = createDb(t);
  if (!db) return;

  const columns = db.db.pragma("table_info('notes')").map((col) => col.name);
  assert.ok(columns.includes("owner_user_id"));
  assert.ok(columns.includes("created_by_user_id"));
  db.db.close();

  const db2 = new DatabaseManager();
  const columns2 = db2.db.pragma("table_info('notes')").map((col) => col.name);
  assert.ok(columns2.includes("owner_user_id"));
  assert.ok(columns2.includes("created_by_user_id"));
  db2.db.close();
});

test("upsertNoteFromCloud stores the cloud owner and never erases a known one", (t) => {
  const db = createDb(t);
  if (!db) return;

  const inserted = db.upsertNoteFromCloud(cloudNote({ user_id: "owner-1" }), null);
  assert.equal(inserted.owner_user_id, "owner-1");

  // A later payload without user_id (older API, partial row) keeps the owner.
  const updated = db.upsertNoteFromCloud(
    cloudNote({ updated_at: "2026-07-03T10:00:00.000Z" }),
    null
  );
  assert.equal(updated.owner_user_id, "owner-1");

  db.db.close();
});

test("cloud creator attribution clears without changing the operational owner", (t) => {
  const db = createDb(t);
  if (!db) return;

  let note = db.upsertNoteFromCloud(
    cloudNote({
      user_id: "workspace-owner",
      created_by_user_id: "departing-user",
      updated_by_user_id: "departing-user",
    }),
    null
  );
  assert.equal(note.owner_user_id, "workspace-owner");
  assert.equal(note.created_by_user_id, "departing-user");

  note = db.upsertNoteFromCloud(
    cloudNote({
      user_id: "workspace-owner",
      created_by_user_id: null,
      updated_by_user_id: null,
      updated_at: "2026-07-03T10:00:00.000Z",
    }),
    null
  );
  assert.equal(note.owner_user_id, "workspace-owner");
  assert.equal(note.created_by_user_id, null);
  assert.equal(note.updated_by_user_id, null);

  db.db.close();
});

test("setNoteOwnerFromCloud fills ownership without touching updated_at or sync_status", (t) => {
  const db = createDb(t);
  if (!db) return;

  // A pre-owner_user_id row: same updated_at locally and in the cloud, so the
  // last-write-wins pull skips the content upsert — ownership must still fill.
  const note = db.upsertNoteFromCloud(cloudNote(), null);
  db.db.prepare("UPDATE notes SET sync_status = 'pending' WHERE id = ?").run(note.id);
  assert.equal(note.owner_user_id, null);

  db.setNoteOwnerFromCloud(note.id, "owner-1");
  const after = db.getNote(note.id);
  assert.equal(after.owner_user_id, "owner-1");
  assert.equal(after.updated_at, note.updated_at);
  assert.equal(after.sync_status, "pending");

  db.db.close();
});

test("countTeamNotesMissingOwner counts only live cloud-backed team notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, "Eng");

  const insert = db.db.prepare(
    `INSERT INTO notes (title, content, client_note_id, space_id, cloud_id, owner_user_id, deleted_at)
     VALUES (?, '', ?, ?, ?, ?, ?)`
  );
  insert.run("missing", "c-1", space.id, "cloud-a", null, null);
  insert.run("owned", "c-2", space.id, "cloud-b", "owner-1", null);
  insert.run("local-only", "c-3", space.id, null, null, null);
  insert.run("tombstone", "c-4", space.id, "cloud-c", null, "2026-07-01T00:00:00.000Z");
  insert.run("personal", "c-5", db.getPrivateSpaceId(), "cloud-d", null, null);

  assert.equal(db.countTeamNotesMissingOwner(), 1);
  db.db.close();
});

test("markNoteSynced and markNoteSyncedIfUnchanged persist the returned owner", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { note } = db.saveNote("Draft", "body");
  db.markNoteSynced(note.id, "cloud-9", "2026-07-02T10:00:00.000Z", "owner-9");
  let row = db.getNote(note.id);
  assert.equal(row.owner_user_id, "owner-9");

  // Like cloud_updated_at, a create ack without user_id resets the owner: a
  // forked row re-creating under a new cloud identity must not keep the old
  // note's owner.
  db.markNoteSynced(note.id, "cloud-9", "2026-07-02T11:00:00.000Z", null);
  row = db.getNote(note.id);
  assert.equal(row.owner_user_id, null);

  // The owner advances with the base even when a mid-flight edit keeps the
  // row pending.
  db.updateNote(note.id, { content: "body v2" });
  const snapshot = db.getNote(note.id);
  db.db
    .prepare("UPDATE notes SET content = 'body v3', sync_status = 'pending' WHERE id = ?")
    .run(note.id);
  const settle = db.markNoteSyncedIfUnchanged(
    note.id,
    snapshot,
    "cloud-9",
    "2026-07-02T12:00:00.000Z",
    "owner-9"
  );
  assert.equal(settle.outcome, "pending");
  assert.equal(settle.changes, 0);
  row = db.getNote(note.id);
  assert.equal(row.owner_user_id, "owner-9");

  db.db.close();
});
