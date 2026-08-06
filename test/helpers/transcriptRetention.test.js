const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-retention-db-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-retention-db-"));
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

function insert(db, text, ageDays, cloudId = null) {
  const { lastInsertRowid } = db.db
    .prepare(
      "INSERT INTO transcriptions (text, created_at, cloud_id) VALUES (?, datetime('now', ?), ?)"
    )
    .run(text, `-${ageDays} days`, cloudId);
  return lastInsertRowid;
}

test("purges local transcriptions past the retention window and keeps the rest", (t) => {
  const db = createDb(t);
  if (!db) return;

  const stale = insert(db, "two days old", 2);
  const fresh = insert(db, "a few hours old", 0);

  const { ids } = db.deleteTranscriptionsExpiredBefore(1);

  assert.deepEqual(ids, [stale]);
  const remaining = db.db
    .prepare("SELECT id FROM transcriptions")
    .all()
    .map((r) => r.id);
  assert.deepEqual(remaining, [fresh]);
});

test("tombstones synced transcriptions instead of deleting them so the cloud copy is removed too", (t) => {
  const db = createDb(t);
  if (!db) return;

  const synced = insert(db, "synced and stale", 10, "cloud-1");
  db.deleteTranscriptionsExpiredBefore(7);

  const row = db.db
    .prepare("SELECT deleted_at, sync_status FROM transcriptions WHERE id = ?")
    .get(synced);
  assert.ok(row.deleted_at, "synced row should be tombstoned, not hard-deleted");
  assert.equal(row.sync_status, "pending");
});

test("ignores rows that are already tombstoned", (t) => {
  const db = createDb(t);
  if (!db) return;

  const synced = insert(db, "already gone", 10, "cloud-1");
  db.deleteTranscriptionsExpiredBefore(7);

  assert.deepEqual(db.deleteTranscriptionsExpiredBefore(7).ids, []);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) c FROM transcriptions WHERE id = ?").get(synced).c,
    1
  );
});
