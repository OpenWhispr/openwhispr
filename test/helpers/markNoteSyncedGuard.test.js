// The sync ack must not flip a note to synced when a local edit landed between
// the push snapshot and the ack: that edit would otherwise never be re-pushed.
// The guard lives in the snapshot-compare acks (acknowledgeNoteCreate for
// creates, markNoteSyncedIfUnchanged for update PATCHes).

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
const LOCAL_LATE = "2026-07-20 11:00:00";

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

test("acknowledgeNoteCreate leaves a row pending when its content changed since the push", (t) => {
  const db = createDb(t);
  if (!db) return;

  const note = db.saveNote("Title", "pushed body", "personal").note;
  updateNote(db, note.id, { updated_at: LOCAL_EARLY });
  const snapshot = db.getNote(note.id);

  // The row moves on after the snapshot was pushed: the ack must not settle it.
  updateNote(db, note.id, { content: "edited during push", updated_at: LOCAL_LATE });
  const rejected = db.acknowledgeNoteCreate(note.id, snapshot, "cloud-1");
  assert.equal(rejected.outcome, "pending", "a mismatched snapshot must not settle the row");
  let row = db.getNote(note.id);
  assert.equal(row.sync_status, "pending", "the mid-push edit stays pushable");
  assert.equal(row.cloud_id, "cloud-1", "the cloud identity is still adopted for the re-push");

  // A matching snapshot settles.
  const clean = db.saveNote("Other", "clean body", "personal").note;
  const cleanSnapshot = db.getNote(clean.id);
  const settled = db.acknowledgeNoteCreate(clean.id, cleanSnapshot, "cloud-2");
  assert.equal(settled.outcome, "synced");
  row = db.getNote(clean.id);
  assert.equal(row.sync_status, "synced");
  assert.equal(row.cloud_id, "cloud-2");
});

test("markNoteSyncedIfUnchanged leaves a row pending when its content changed since the push", (t) => {
  const db = createDb(t);
  if (!db) return;

  const note = db.saveNote("Title", "pushed body", "personal").note;
  updateNote(db, note.id, { cloud_id: "cloud-1", updated_at: LOCAL_EARLY });
  const snapshot = db.getNote(note.id);

  updateNote(db, note.id, { content: "edited during push", updated_at: LOCAL_LATE });
  const rejected = db.markNoteSyncedIfUnchanged(note.id, snapshot, "cloud-1");
  assert.equal(rejected.outcome, "pending", "a mismatched snapshot must not settle the row");
  assert.equal(db.getNote(note.id).sync_status, "pending", "the mid-push edit stays pushable");

  const fresh = db.getNote(note.id);
  const settled = db.markNoteSyncedIfUnchanged(note.id, fresh, "cloud-1");
  assert.equal(settled.outcome, "synced");
  assert.equal(db.getNote(note.id).sync_status, "synced");
});

test("an edit landing during the push survives: the row stays pending and re-pushes", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;

  const note = db.saveNote("Racy note", "original body", "personal").note;
  updateNote(db, note.id, { created_at: LOCAL_EARLY, updated_at: LOCAL_EARLY });

  // Simulate the race: the edit lands right after the push reads its snapshot.
  const realGetPending = api.getPendingNotes;
  let raced = false;
  api.getPendingNotes = async (spaceKind) => {
    const rows = await realGetPending(spaceKind);
    if (!raced && rows.length > 0) {
      raced = true;
      updateNote(db, note.id, {
        content: "edited during push",
        updated_at: LOCAL_LATE,
        sync_status: "pending",
      });
    }
    return rows;
  };

  await service.syncAll(true);

  const afterFirst = db.getNote(note.id);
  assert.equal(
    afterFirst.sync_status,
    "pending",
    "the ack must not swallow the edit that landed during the push"
  );

  await service.syncAll(true);

  const afterSecond = db.getNote(note.id);
  assert.equal(afterSecond.sync_status, "synced", "the second pass re-pushes the edit");
  assert.equal(afterSecond.content, "edited during push");
  const cloudRow = cloud.note(afterSecond.cloud_id);
  assert.equal(
    cloudRow.content,
    "edited during push",
    "the cloud must end up with the edit, not the stale snapshot"
  );
});
