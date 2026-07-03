const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

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

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-snippets-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    if (String(error?.message || error).includes("NODE_MODULE_VERSION")) {
      t.skip("better-sqlite3 native binding is not compiled for this Node runtime");
      return null;
    }
    throw error;
  }

  try {
    return new DatabaseManager();
  } catch (error) {
    if (String(error?.message || error).includes("NODE_MODULE_VERSION")) {
      t.skip("better-sqlite3 native binding is not compiled for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("snippets diff trims, dedupes, updates, and preserves synced no-ops", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setSnippets([
    { trigger: "  signoff  ", replacement: "  Regards  " },
    { trigger: "SIGNOFF", replacement: "Ignored duplicate" },
  ]);

  assert.deepEqual(db.getSnippets(), [{ trigger: "signoff", replacement: "Regards" }]);
  const [created] = db.getPendingSnippets();
  assert.ok(created.client_snippet_id);

  db.markSnippetSynced(created.id, "cloud-1", "2026-07-01T10:00:00.000Z");
  db.setSnippets([{ trigger: "signoff", replacement: "Regards" }]);
  assert.equal(db.getPendingSnippets().length, 0);

  db.setSnippets([{ trigger: "signoff", replacement: "Best regards" }]);
  const [updated] = db.getPendingSnippets();
  assert.equal(updated.id, created.id);
  assert.equal(updated.replacement, "Best regards");
});

test("snippet removals hard-delete unsynced rows and tombstone synced rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setSnippets([{ trigger: "temp", replacement: "Temporary" }]);
  db.setSnippets([]);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM snippets").get().count, 0);

  db.setSnippets([{ trigger: "synced", replacement: "Synced" }]);
  const [created] = db.getPendingSnippets();
  db.markSnippetSynced(created.id, "cloud-2", "2026-07-01T10:00:00.000Z");

  db.setSnippets([]);
  assert.deepEqual(db.getSnippets(), []);
  const [deleted] = db.getPendingSnippetDeletes();
  assert.equal(deleted.id, created.id);
  assert.equal(deleted.cloud_id, "cloud-2");
});

test("cloud snippets upsert by client id, cloud id, then trigger", (t) => {
  const db = createDb(t);
  if (!db) return;

  const first = db.upsertSnippetFromCloud({
    id: "cloud-1",
    client_snippet_id: "client-1",
    trigger: "intro",
    replacement: "Hello there",
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
  });
  assert.equal(first.trigger, "intro");
  assert.equal(first.sync_status, "synced");

  const byClient = db.upsertSnippetFromCloud({
    id: "cloud-1",
    client_snippet_id: "client-1",
    trigger: "intro",
    replacement: "Hello again",
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T11:00:00.000Z",
  });
  assert.equal(byClient.id, first.id);
  assert.equal(byClient.replacement, "Hello again");

  const byTrigger = db.upsertSnippetFromCloud({
    id: "cloud-2",
    client_snippet_id: "client-2",
    trigger: "INTRO",
    replacement: "Case merge",
    created_at: "2026-07-01T12:00:00.000Z",
    updated_at: "2026-07-01T12:00:00.000Z",
  });
  assert.equal(byTrigger.id, first.id);
  assert.equal(byTrigger.cloud_id, "cloud-2");
  assert.equal(byTrigger.client_snippet_id, "client-2");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM snippets").get().count, 1);
});

test("cloud rename onto a trigger another active snippet holds converges without throwing", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSnippetFromCloud({
    id: "cloud-a",
    client_snippet_id: "ca",
    trigger: "foo",
    replacement: "Foo text",
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
  });
  db.upsertSnippetFromCloud({
    id: "cloud-b",
    client_snippet_id: "cb",
    trigger: "bar",
    replacement: "Bar text",
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
  });

  const merged = db.upsertSnippetFromCloud({
    id: "cloud-a",
    client_snippet_id: "ca",
    trigger: "bar",
    replacement: "Foo renamed",
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T12:00:00.000Z",
  });

  assert.equal(merged.trigger, "bar");
  assert.equal(merged.cloud_id, "cloud-a");
  assert.deepEqual(db.getSnippets(), [{ trigger: "bar", replacement: "Foo renamed" }]);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM snippets").get().count, 1);
});

test("markSnippetSynced leaves a row pending when its content changed since the push", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setSnippets([{ trigger: "brb", replacement: "be right back" }]);
  const [pushed] = db.getPendingSnippets();

  // A concurrent edit lands while the push (snapshot 'be right back') is in flight.
  db.setSnippets([{ trigger: "brb", replacement: "back in a bit" }]);

  const stale = db.markSnippetSynced(
    pushed.id,
    "cloud-1",
    "2026-07-01T10:00:00.000Z",
    "brb",
    "be right back"
  );
  assert.equal(stale.changes, 0);
  const [stillPending] = db.getPendingSnippets();
  assert.equal(stillPending.id, pushed.id);
  assert.equal(stillPending.replacement, "back in a bit");
  assert.equal(stillPending.cloud_id, null);

  const ok = db.markSnippetSynced(
    pushed.id,
    "cloud-1",
    "2026-07-01T11:00:00.000Z",
    "brb",
    "back in a bit"
  );
  assert.equal(ok.changes, 1);
  assert.equal(db.getPendingSnippets().length, 0);
});

test("setSnippets drops triggers longer than the sync limit", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setSnippets([
    { trigger: "x".repeat(101), replacement: "too long" },
    { trigger: "ok", replacement: "fine" },
  ]);

  assert.deepEqual(db.getSnippets(), [{ trigger: "ok", replacement: "fine" }]);
});
