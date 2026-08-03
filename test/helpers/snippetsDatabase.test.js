const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-snippets-db-"));
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

const SYNC_TABLES = [
  "transcriptions",
  "custom_dictionary",
  "snippets",
  "notes",
  "folders",
  "agent_conversations",
];

function freshUserDataDir() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-snippets-db-"));
  return userDataDir;
}

function createDb() {
  requireSqlite();
  freshUserDataDir();
  return new DatabaseManager();
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

test("snippets diff trims, dedupes, and updates in place", () => {
  const db = createDb();

  db.setSnippets([
    { trigger: "  signoff  ", replacement: "  Regards  " },
    { trigger: "SIGNOFF", replacement: "Ignored duplicate" },
  ]);
  assert.deepEqual(db.getSnippets(), [{ trigger: "signoff", replacement: "Regards" }]);

  const created = db.db.prepare("SELECT id FROM snippets").get();

  // An unchanged write is a no-op and must not churn the row.
  db.setSnippets([{ trigger: "signoff", replacement: "Regards" }]);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM snippets").get().c, 1);

  db.setSnippets([{ trigger: "signoff", replacement: "Best regards" }]);
  const updated = db.db.prepare("SELECT id, replacement FROM snippets").get();
  assert.equal(updated.id, created.id, "an edit updates in place rather than recreating the row");
  assert.equal(updated.replacement, "Best regards");
});

test("removing a snippet hard-deletes it", () => {
  const db = createDb();

  db.setSnippets([{ trigger: "temp", replacement: "Temporary" }]);
  db.setSnippets([]);

  assert.deepEqual(db.getSnippets(), []);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS c FROM snippets").get().c,
    0,
    "no tombstone row is left behind now that there is no cloud to notify"
  );
});

test("setSnippets drops triggers longer than the length limit", () => {
  const db = createDb();

  db.setSnippets([
    { trigger: "x".repeat(101), replacement: "too long" },
    { trigger: "ok", replacement: "fine" },
  ]);

  assert.deepEqual(db.getSnippets(), [{ trigger: "ok", replacement: "fine" }]);
});

test("dictionary diff adds, updates, and hard-deletes", () => {
  const db = createDb();

  db.setDictionary(["alpha", "beta"]);
  assert.deepEqual([...db.getDictionary()].sort(), ["alpha", "beta"]);

  db.setDictionary(["alpha"]);
  assert.deepEqual(db.getDictionary(), ["alpha"]);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS c FROM custom_dictionary").get().c,
    1,
    "removed words are hard-deleted, not tombstoned"
  );
});

test("deleting a transcription removes the row outright", () => {
  const db = createDb();

  const saved = db.saveTranscription("hello world");
  assert.ok(saved.id);

  const result = db.deleteTranscription(saved.id);
  assert.equal(result.success, true);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM transcriptions").get().c, 0);
});

test("schema carries no cloud sync columns", () => {
  const db = createDb();

  for (const table of SYNC_TABLES) {
    const cols = columnNames(db.db, table);
    assert.ok(!cols.includes("cloud_id"), `${table} must not have cloud_id`);
    assert.ok(!cols.includes("sync_status"), `${table} must not have sync_status`);
  }

  const staleIndex = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_snippets_pending_sync'")
    .get();
  assert.equal(staleIndex, undefined, "the partial index on sync_status must be gone");
});

test("migrating a legacy database drops the sync columns and keeps the data", () => {
  const BetterSqlite = requireSqlite();
  const dir = freshUserDataDir();
  const legacy = new BetterSqlite(path.join(dir, "transcriptions.db"));
  legacy.exec(`
    CREATE TABLE transcriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      cloud_id TEXT,
      sync_status TEXT DEFAULT 'pending',
      deleted_at TEXT
    );
    CREATE TABLE snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT NOT NULL,
      replacement TEXT NOT NULL,
      client_snippet_id TEXT,
      cloud_id TEXT,
      sync_status TEXT DEFAULT 'pending',
      deleted_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_snippets_pending_sync ON snippets(sync_status) WHERE sync_status = 'pending';
    INSERT INTO transcriptions (text, cloud_id, sync_status) VALUES ('kept row', 'cloud-9', 'synced');
    INSERT INTO snippets (trigger, replacement, cloud_id) VALUES ('brb', 'be right back', 'cloud-8');
  `);
  legacy.close();

  const db = new DatabaseManager();

  for (const table of ["transcriptions", "snippets"]) {
    const cols = columnNames(db.db, table);
    assert.ok(!cols.includes("cloud_id"), `${table}.cloud_id must be dropped`);
    assert.ok(!cols.includes("sync_status"), `${table}.sync_status must be dropped`);
  }

  assert.equal(db.db.prepare("SELECT text FROM transcriptions").get().text, "kept row");
  assert.deepEqual(db.getSnippets(), [{ trigger: "brb", replacement: "be right back" }]);

  const staleIndex = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_snippets_pending_sync'")
    .get();
  assert.equal(staleIndex, undefined);
});

test("migration is idempotent across reopens", () => {
  const db = createDb();
  db.setSnippets([{ trigger: "brb", replacement: "be right back" }]);
  db.db.close();

  const reopened = new DatabaseManager();
  assert.deepEqual(reopened.getSnippets(), [{ trigger: "brb", replacement: "be right back" }]);
  for (const table of SYNC_TABLES) {
    const cols = columnNames(reopened.db, table);
    assert.ok(!cols.includes("cloud_id"));
    assert.ok(!cols.includes("sync_status"));
  }
});
