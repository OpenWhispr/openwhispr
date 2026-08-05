const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-dict-usage-db-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-dict-usage-db-"));
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

function entryFor(db, word) {
  return db.getDictionaryEntries().find((e) => e.word === word);
}

test("migration adds usage columns defaulting to zero", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applyDictionaryChanges({ add: ["Qdrant"] });
  const entry = entryFor(db, "Qdrant");
  assert.equal(entry.usage_count, 0);
  assert.equal(entry.last_used_at, null);
  assert.equal(entry.source, "manual");
  assert.ok(entry.id > 0);
  assert.ok(entry.created_at);
});

test("recordDictionaryUsage increments matched words and stamps last_used_at", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applyDictionaryChanges({ add: ["Qdrant", "Vite"] });
  const result = db.recordDictionaryUsage("Deploying Qdrant next to Qdrant today");
  assert.deepEqual(result, { success: true, matched: 1 });

  assert.equal(entryFor(db, "Qdrant").usage_count, 2);
  assert.ok(entryFor(db, "Qdrant").last_used_at);
  assert.equal(entryFor(db, "Vite").usage_count, 0);
  assert.equal(entryFor(db, "Vite").last_used_at, null);
});

test("usage updates leave sync_status and updated_at untouched", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applyDictionaryChanges({ add: ["Qdrant"] });
  const row = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Qdrant'").get();
  db.markDictionaryEntrySynced(row.id, "cloud-1");
  const before = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Qdrant'").get();
  assert.equal(before.sync_status, "synced");

  db.recordDictionaryUsage("Qdrant is running");

  const after = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Qdrant'").get();
  assert.equal(after.usage_count, 1);
  assert.equal(after.sync_status, "synced");
  assert.equal(after.updated_at, before.updated_at);
  assert.deepEqual(db.getPendingDictionary(), []);
});

test("getDictionary orders most-used first with insertion order as tie-break", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applyDictionaryChanges({ add: ["Alpha", "Beta", "Gamma"] });
  db.recordDictionaryUsage("Beta Beta Gamma");

  assert.deepEqual(db.getDictionary(), ["Beta", "Gamma", "Alpha"]);
});

test("recordDictionaryUsage ignores tombstoned words", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applyDictionaryChanges({ add: ["Qdrant"] });
  const row = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Qdrant'").get();
  db.markDictionaryEntrySynced(row.id, "cloud-1");
  db.applyDictionaryChanges({ remove: ["Qdrant"] });

  const result = db.recordDictionaryUsage("Qdrant is still spoken");
  assert.deepEqual(result, { success: true, matched: 0 });

  const tombstoned = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Qdrant'").get();
  assert.ok(tombstoned.deleted_at);
  assert.equal(tombstoned.usage_count, 0);
});

test("cloud pull upsert preserves local usage counters", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applyDictionaryChanges({ add: ["Qdrant"] });
  db.recordDictionaryUsage("Qdrant here");
  const local = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Qdrant'").get();
  assert.equal(local.usage_count, 1);

  db.upsertDictionaryFromCloud({
    id: "cloud-9",
    client_dict_id: local.client_dict_id,
    word: "Qdrant",
    source: "manual",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
  });

  const after = entryFor(db, "Qdrant");
  assert.equal(after.usage_count, 1);
  assert.ok(after.last_used_at);
});

test("recordDictionaryUsage reports zero matches for blank text or empty dictionary", (t) => {
  const db = createDb(t);
  if (!db) return;

  assert.deepEqual(db.recordDictionaryUsage("anything"), { success: true, matched: 0 });
  db.applyDictionaryChanges({ add: ["Qdrant"] });
  assert.deepEqual(db.recordDictionaryUsage("   "), { success: true, matched: 0 });
  assert.deepEqual(db.recordDictionaryUsage(null), { success: true, matched: 0 });
});

test("legacy case-variant duplicate rows are credited once per occurrence", (t) => {
  const db = createDb(t);
  if (!db) return;

  // Bypass the write-path dedupe the way legacy rows predate it.
  const insert = db.db.prepare("INSERT INTO custom_dictionary (word) VALUES (?)");
  insert.run("Qdrant");
  insert.run("qdrant");

  db.recordDictionaryUsage("qdrant is here");

  const total = db.db
    .prepare("SELECT SUM(usage_count) AS total FROM custom_dictionary")
    .get().total;
  assert.equal(total, 1);
});
