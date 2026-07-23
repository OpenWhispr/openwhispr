const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-dict-db-"));
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
const loadStartup = () => import("../../src/helpers/dictionaryStartup.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") || message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-dict-db-"));
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
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("setDictionary replaces the full dictionary (why a stale cache wipe was destructive)", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice", "Bob"]);
  assert.deepEqual(db.getDictionary(), ["OpenWhispr", "Alice", "Bob"]);

  // Writing only the cached subset is exactly what startup used to do.
  db.setDictionary(["OpenWhispr"]);
  assert.deepEqual(db.getDictionary(), ["OpenWhispr"]);
});

test("startup reconcile preserves DB words that a stale renderer cache omitted (#1295)", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const { chooseDictionaryStartupAction } = await loadStartup();

  db.setDictionary(["OpenWhispr", "Alice", "Bob", "Imported Term"]);
  const staleCache = ["OpenWhispr"];
  const decision = chooseDictionaryStartupAction(db.getDictionary(), staleCache);
  assert.equal(decision.action, "pull-db-to-local");

  // After adopting the DB snapshot, rewriting that same list (agent name already
  // present) must not delete the words the stale cache lacked.
  db.setDictionary(decision.words);
  assert.deepEqual(db.getDictionary(), ["OpenWhispr", "Alice", "Bob", "Imported Term"]);
});

test("getPendingDictionary backfills missing client_dict_id before sync", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice"]);
  db.db.prepare("UPDATE custom_dictionary SET client_dict_id = NULL WHERE word = 'Alice'").run();

  const before = db.db
    .prepare("SELECT client_dict_id FROM custom_dictionary WHERE word = 'Alice'")
    .get();
  assert.equal(before.client_dict_id, null);

  const pending = db.getPendingDictionary();
  const alice = pending.find((row) => row.word === "Alice");
  assert.ok(alice);
  assert.ok(alice.client_dict_id);
  assert.equal(alice.cloud_id, null);
  assert.equal(alice.sync_status, "pending");
});

test("cloud pull upserts remotes without deleting local-only pending rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice"]);
  const alice = db.getPendingDictionary().find((row) => row.word === "Alice");

  db.upsertDictionaryFromCloud({
    id: "cloud-remote-1",
    client_dict_id: "client-remote-1",
    word: "Carol",
    source: "manual",
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-22T10:00:00.000Z",
  });

  assert.deepEqual(db.getDictionary().sort(), ["Alice", "Carol", "OpenWhispr"].sort());
  const aliceAfter = db.db.prepare("SELECT * FROM custom_dictionary WHERE id = ?").get(alice.id);
  assert.equal(aliceAfter.sync_status, "pending");
  assert.equal(aliceAfter.cloud_id, null);
});

test("repeated cloud upsert does not duplicate words", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr"]);
  const payload = {
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "Delta",
    source: "manual",
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-22T10:00:00.000Z",
  };

  db.upsertDictionaryFromCloud(payload);
  db.upsertDictionaryFromCloud({
    ...payload,
    updated_at: "2026-07-22T11:00:00.000Z",
  });

  const deltas = db.db
    .prepare("SELECT COUNT(*) AS count FROM custom_dictionary WHERE lower(word) = 'delta'")
    .get();
  assert.equal(deltas.count, 1);
  assert.deepEqual(db.getDictionary().sort(), ["Delta", "OpenWhispr"].sort());
});

test("default OpenWhispr row is neither removed nor duplicated by cloud upsert", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice"]);
  db.upsertDictionaryFromCloud({
    id: "cloud-ow",
    client_dict_id: "client-ow",
    word: "OpenWhispr",
    source: "manual",
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-22T12:00:00.000Z",
  });

  const openWhisprRows = db.db
    .prepare("SELECT * FROM custom_dictionary WHERE lower(word) = 'openwhispr'")
    .all();
  assert.equal(openWhisprRows.length, 1);
  assert.equal(openWhisprRows[0].cloud_id, "cloud-ow");
  assert.ok(db.getDictionary().includes("Alice"));
});

test("intentional removal tombstones synced rows and hard-deletes unsynced ones", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Temp", "Synced"]);
  const pending = db.getPendingDictionary();
  const synced = pending.find((row) => row.word === "Synced");
  db.markDictionaryEntrySynced(synced.id, "cloud-synced");

  db.setDictionary(["OpenWhispr"]);
  assert.deepEqual(db.getDictionary(), ["OpenWhispr"]);

  const tempGone = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Temp'").get();
  assert.equal(tempGone, undefined);

  const syncedTombstone = db.db
    .prepare("SELECT * FROM custom_dictionary WHERE word = 'Synced'")
    .get();
  assert.ok(syncedTombstone.deleted_at);
  assert.equal(syncedTombstone.sync_status, "pending");
  assert.equal(syncedTombstone.cloud_id, "cloud-synced");
});
