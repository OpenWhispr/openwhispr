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

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The reporter's scenario: a bulk import writing straight to the table, with no
// knowledge of the sync columns. Those rows still have to be uploadable (#1295).
test("rows inserted outside the app get a client_dict_id from the schema", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr"]);
  db.db.prepare("INSERT INTO custom_dictionary (word) VALUES (?)").run("Contact Name");

  const row = db.db
    .prepare("SELECT * FROM custom_dictionary WHERE word = 'Contact Name'")
    .get();
  assert.match(row.client_dict_id, UUID_V4);

  const pending = db.getPendingDictionary().find((r) => r.word === "Contact Name");
  assert.ok(pending, "externally inserted row should be uploadable");
  assert.equal(pending.cloud_id, null);
  assert.equal(pending.sync_status, "pending");
});

test("externally inserted rows get distinct client_dict_ids", (t) => {
  const db = createDb(t);
  if (!db) return;

  const insert = db.db.prepare("INSERT INTO custom_dictionary (word) VALUES (?)");
  for (const word of ["Alpha", "Beta", "Gamma"]) insert.run(word);

  const ids = db.db
    .prepare("SELECT client_dict_id FROM custom_dictionary WHERE word IN ('Alpha','Beta','Gamma')")
    .all()
    .map((r) => r.client_dict_id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
});

test("an explicitly supplied client_dict_id is preserved", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.db
    .prepare("INSERT INTO custom_dictionary (word, client_dict_id) VALUES (?, ?)")
    .run("Delta", "supplied-id");

  const row = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Delta'").get();
  assert.equal(row.client_dict_id, "supplied-id");
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

// applyDictionaryChanges is the delta write path. Its whole purpose is that a
// caller can only affect the words it names, so the wipe in #1295 stops being
// expressible rather than merely guarded against.

test("adding words leaves every other row untouched", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice", "Bob"]);
  const result = db.applyDictionaryChanges({ add: ["Carol"] });

  assert.equal(result.added, 1);
  assert.deepEqual(db.getDictionary(), ["OpenWhispr", "Alice", "Bob", "Carol"]);
});

test("a caller holding a stale one-word view cannot delete anything (#1295)", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice", "Bob", "Imported Term"]);
  // The exact call startup used to make, but expressed as a delta.
  db.applyDictionaryChanges({ add: ["OpenWhispr"] });

  assert.deepEqual(db.getDictionary(), ["OpenWhispr", "Alice", "Bob", "Imported Term"]);
});

test("removing words hard-deletes unsynced rows and tombstones synced ones", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Temp", "Synced"]);
  const synced = db.getPendingDictionary().find((row) => row.word === "Synced");
  db.markDictionaryEntrySynced(synced.id, "cloud-synced");

  const result = db.applyDictionaryChanges({ remove: ["Temp", "Synced"] });
  assert.equal(result.removed, 2);
  assert.deepEqual(db.getDictionary(), ["OpenWhispr"]);

  assert.equal(db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Temp'").get(), undefined);
  const tombstone = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Synced'").get();
  assert.ok(tombstone.deleted_at);
  assert.equal(tombstone.sync_status, "pending");
  assert.equal(tombstone.cloud_id, "cloud-synced");
});

test("adding a tombstoned word restores it instead of duplicating", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Synced"]);
  const synced = db.getPendingDictionary().find((row) => row.word === "Synced");
  db.markDictionaryEntrySynced(synced.id, "cloud-synced");
  db.applyDictionaryChanges({ remove: ["Synced"] });

  db.applyDictionaryChanges({ add: ["Synced"] });

  const rows = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Synced'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deleted_at, null);
  assert.equal(rows[0].cloud_id, "cloud-synced");
  assert.ok(db.getDictionary().includes("Synced"));
});

test("a manual add promotes a learned word, matching setDictionary", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applyDictionaryChanges({ add: ["Kubernetes"] }, "learned");
  assert.equal(
    db.db.prepare("SELECT source FROM custom_dictionary WHERE word = 'Kubernetes'").get().source,
    "learned"
  );

  db.applyDictionaryChanges({ add: ["Kubernetes"] }, "manual");
  assert.equal(
    db.db.prepare("SELECT source FROM custom_dictionary WHERE word = 'Kubernetes'").get().source,
    "manual"
  );
});

test("an edit is a remove plus an add in one transaction", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Kubernets", "Alice"]);
  db.applyDictionaryChanges({ add: ["Kubernetes"], remove: ["Kubernets"] });

  assert.deepEqual(db.getDictionary(), ["OpenWhispr", "Alice", "Kubernetes"]);
});

test("a word on both sides is kept, not deleted", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice"]);
  const result = db.applyDictionaryChanges({ add: ["Alice"], remove: ["Alice"] });

  assert.equal(result.removed, 0);
  assert.ok(db.getDictionary().includes("Alice"));
});

// Removing via setDictionary meant re-presenting every surviving word with the
// default 'manual' source, which promoted unrelated auto-learned words and
// marked them pending. A delta names only what it changes.
test("removing a word leaves other learned words untouched", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applyDictionaryChanges({ add: ["Kubernetes", "Postgres"] }, "learned");
  const before = db.db
    .prepare("SELECT word, source FROM custom_dictionary WHERE word = 'Postgres'")
    .get();
  assert.equal(before.source, "learned");

  db.applyDictionaryChanges({ remove: ["Kubernetes"] });

  const after = db.db
    .prepare("SELECT word, source FROM custom_dictionary WHERE word = 'Postgres'")
    .get();
  assert.equal(after.source, "learned");
});

test("counts report words that changed, not words requested", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice"]);

  // Already present, so nothing was actually added.
  assert.equal(db.applyDictionaryChanges({ add: ["Alice"] }).added, 0);
  // Never present, so nothing was actually removed.
  assert.equal(db.applyDictionaryChanges({ remove: ["Nobody"] }).removed, 0);

  const mixed = db.applyDictionaryChanges({ add: ["Alice", "Carol"], remove: ["Nobody", "Alice"] });
  assert.equal(mixed.added, 1);
  assert.equal(mixed.removed, 0);
});

test("an empty delta touches nothing", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice"]);
  const synced = db.getPendingDictionary().find((row) => row.word === "Alice");
  db.markDictionaryEntrySynced(synced.id, "cloud-alice");

  const result = db.applyDictionaryChanges({});
  assert.deepEqual(result, { success: true, added: 0, removed: 0 });

  // Still synced: an empty delta must not mark rows pending again.
  const after = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Alice'").get();
  assert.equal(after.sync_status, "synced");
  assert.deepEqual(db.getDictionary(), ["OpenWhispr", "Alice"]);
});

test("removing a word that isn't there is a no-op", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr"]);
  const result = db.applyDictionaryChanges({ remove: ["Nonexistent"] });
  assert.equal(result.removed, 0);
  assert.deepEqual(db.getDictionary(), ["OpenWhispr"]);
});

test("case-variant adds do not create duplicate rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionary(["OpenWhispr", "Alice"]);
  db.applyDictionaryChanges({ add: ["alice", "ALICE"] });

  const rows = db.db
    .prepare("SELECT * FROM custom_dictionary WHERE lower(word) = 'alice' AND deleted_at IS NULL")
    .all();
  assert.equal(rows.length, 1);
});
