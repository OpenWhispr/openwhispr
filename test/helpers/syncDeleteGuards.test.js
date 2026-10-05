// A local tombstone must outlive a pull, and delete pushes must never reach the
// cloud for rows that were never synced.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");

const LOCAL_EARLY = "2026-07-20 10:00:00";

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  const api = createElectronApi(db, { cloud });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, cloud, api, service };
}

function updateNote(db, id, fields) {
  const keys = Object.keys(fields);
  db.db
    .prepare(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return db.getNote(id);
}

function silenceConsoleErrors(t) {
  t.mock.method(console, "error", () => {});
}

test("a local tombstone survives a pull serving a newer cloud copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  const note = db.saveNote("Doomed", "body", "personal").note;
  const local = db.getNote(note.id);
  const cloudRow = cloud.seedNote({
    client_note_id: local.client_note_id,
    title: "Doomed",
    content: "body",
    updated_at: "2026-07-20T09:00:00.000Z",
  });
  updateNote(db, note.id, {
    cloud_id: cloudRow.id,
    sync_status: "synced",
    created_at: LOCAL_EARLY,
    updated_at: LOCAL_EARLY,
  });

  // The user deletes locally; another device edits the same note afterwards.
  db.deleteNote(note.id);
  updateNote(db, note.id, { updated_at: LOCAL_EARLY });
  cloud.seedNote({
    client_note_id: local.client_note_id,
    title: "Doomed",
    content: "edited elsewhere after the delete",
    updated_at: "2026-07-20T11:30:00.000Z",
  });

  // The delete push fails this pass, so the tombstone is still local when the
  // pull runs in the same syncAll.
  cloud.failNext("DELETE /api/notes/delete", { status: 500, error: "boom" });

  await service.syncAll(true);

  const afterPull = db.getNote(note.id);
  assert.ok(afterPull, "the tombstone row must still exist locally");
  assert.ok(
    afterPull.deleted_at,
    "the pull must not resurrect a locally deleted note over its tombstone"
  );
  assert.equal(afterPull.sync_status, "pending", "the pending delete must stay pushable");

  await service.syncAll(true);

  assert.equal(db.getNote(note.id), null, "the second pass pushes the delete and clears the row");
  assert.ok(cloud.note(cloudRow.id).deleted_at, "the cloud row ends up tombstoned");
});

test("a never-synced pending note delete makes no cloud call", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, api, service } = ctx;
  silenceConsoleErrors(t);

  // Defense in depth: getPendingNoteDeletes filters cloud_id in SQL today, so a
  // null can only arrive through a regressed query or bridge. Simulate that.
  api.getPendingNoteDeletes = async () => [
    { id: 41, cloud_id: null, client_note_id: "never-synced" },
  ];

  await service.syncAll(true);

  assert.equal(
    cloud.logFor("/api/notes/delete").length,
    0,
    "a delete without a cloud id must never reach the cloud"
  );
});

test("a never-synced pending conversation delete makes no cloud call", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, api, service } = ctx;
  silenceConsoleErrors(t);

  api.getPendingConversationDeletes = async () => [
    { id: 41, cloud_id: null, client_conversation_id: "never-synced" },
  ];

  await service.syncAll(true);

  assert.equal(
    cloud.logFor("/api/conversations/delete").length,
    0,
    "a conversation delete without a cloud id must never reach the cloud"
  );
});
