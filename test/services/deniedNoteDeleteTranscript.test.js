const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../helpers/harness/db.js");
const { createSyncDevice } = require("../helpers/harness/syncDevice.js");
const { createAccountCloud } = require("../helpers/harness/fakeCloud.js");
const { stopSyncTimers } = require("../helpers/harness/browserGlobals.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { readNoteConflicts } = require("../../src/lib/noteConflictRegistry.ts");

// The user deletes the note being recorded and stops before its cloud delete is
// answered. The recording's final transcript stays on the tombstone: a delete the
// server denies brings the note back with it, a confirmed one takes both.

const OWNER = "recording-owner";
const BEFORE = "said before the delete";
const FINAL = "said before the delete\nsaid after the delete";
const DENIED = { status: 403, code: "note_access_denied", error: "Only the owner may delete" };

async function setup(t) {
  const device = createSyncDevice(t);
  if (!device) return null;
  // The current server: writes carry revisions and a stale base is refused.
  const cloud = createAccountCloud({ revisionGuard: true });
  await device.signIn(OWNER, cloud);
  const spaceId = device.db.getDefaultPrivateSpaceId();
  const note = device.db.saveNote("Standup", "", "meeting", null, null, null, spaceId, BEFORE).note;
  await device.service.syncAll(true);
  const cloudId = device.db.getNote(note.id).cloud_id;
  assert.ok(cloudId);
  return { device, cloud, noteId: note.id, cloudId };
}

const noteRow = (db, id) => db.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) ?? null;
const guardFor = (accountId) => ({ accountId, authGeneration: 0 });

// Deleted here, then the stop keeps its transcript on the tombstone.
async function deleteThenStop(device, noteId) {
  assert.equal(device.db.deleteNote(noteId).success, true);
  const kept = await device.api.keepDeletedNoteTranscript(noteId, FINAL, guardFor(OWNER));
  assert.equal(kept.success, true);
  const tombstone = noteRow(device.db, noteId);
  assert.ok(tombstone.deleted_at, "still deleted");
  assert.equal(tombstone.sync_status, "pending", "its delete still goes out");
  assert.deepEqual(
    device.db.getPendingNoteDeletes().map((row) => row.id),
    [noteId]
  );
}

test("a denied delete brings the note back with the transcript kept after it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud, noteId, cloudId } = ctx;
  await deleteThenStop(device, noteId);

  cloud.failNext("DELETE /api/notes/delete", DENIED);
  await device.service.syncAll(true);

  const restored = noteRow(device.db, noteId);
  assert.equal(restored.deleted_at, null);
  assert.equal(restored.transcript, FINAL, "the snapshot pull kept it");
  assert.equal(restored.sync_status, "synced", "and the re-run pushed it");
  assert.equal(cloud.note(cloudId).transcript, FINAL);
  assert.equal(cloud.note(cloudId).deleted_at, null);
  assert.deepEqual(readNoteConflicts(), {}, "no conflict");
});

test("the delete denied in a later pass, after the window reopened, keeps it too", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud, noteId, cloudId } = ctx;
  await deleteThenStop(device, noteId);

  cloud.failNext("DELETE /api/notes/delete", { status: 500, error: "offline" });
  await device.service.syncAll(true);
  assert.ok(noteRow(device.db, noteId).deleted_at, "nothing answered yet");

  const reopened = new SyncService();
  t.after(() => stopSyncTimers(reopened));
  cloud.failNext("DELETE /api/notes/delete", DENIED);
  await reopened.syncAll(true);

  assert.equal(noteRow(device.db, noteId).deleted_at, null);
  assert.equal(noteRow(device.db, noteId).transcript, FINAL);
  assert.equal(cloud.note(cloudId).transcript, FINAL);
});

test("a confirmed delete takes the kept transcript with the note", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud, noteId, cloudId } = ctx;
  await deleteThenStop(device, noteId);

  await device.service.syncAll(true);

  assert.equal(noteRow(device.db, noteId), null);
  assert.ok(cloud.note(cloudId).deleted_at);
  assert.deepEqual(
    device.db.db.prepare("SELECT id FROM notes WHERE transcript LIKE '%after the delete%'").all(),
    [],
    "no copy here"
  );
  assert.deepEqual(
    cloud.notes().filter((row) => !row.deleted_at),
    [],
    "and none in the cloud"
  );
});

test("a denied delete with nothing written after it still takes the server's copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud, noteId, cloudId } = ctx;
  assert.equal(device.db.deleteNote(noteId).success, true);
  // A teammate's edit while the delete waits.
  await cloud.request({
    method: "PATCH",
    path: "/api/notes/update",
    body: { id: cloudId, transcript: "the server's newer transcript" },
  });

  cloud.failNext("DELETE /api/notes/delete", DENIED);
  await device.service.syncAll(true);

  const restored = noteRow(device.db, noteId);
  assert.equal(restored.deleted_at, null);
  assert.equal(restored.sync_status, "synced");
  assert.equal(restored.transcript, "the server's newer transcript");
  assert.deepEqual(readNoteConflicts(), {});
});

test("only the recording's account keeps a transcript, and only on a pending delete", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, noteId } = ctx;

  const live = await device.api.keepDeletedNoteTranscript(noteId, FINAL, guardFor(OWNER));
  assert.deepEqual(live, { success: false, id: noteId, code: "note_live" });
  assert.equal(noteRow(device.db, noteId).transcript, BEFORE, "a live note isn't written here");

  assert.equal(device.db.deleteNote(noteId).success, true);
  const stamp = noteRow(device.db, noteId).updated_at;
  const other = await device.api.keepDeletedNoteTranscript(noteId, FINAL, guardFor("someone"));
  assert.equal(other.success, false);
  device.db.setActiveAccountId("someone");
  assert.equal(device.db.keepTranscriptOnDeletedNote(noteId, FINAL).success, false);
  device.db.setActiveAccountId(OWNER);
  const row = noteRow(device.db, noteId);
  assert.equal(row.transcript, BEFORE);
  assert.equal(row.updated_at, stamp);
});

// Only a kept transcript brings a note back pending. Writes that merely touch a
// tombstone (moving its updated_at) leave it to take the server's copy.
function syncedNoteIn(db, folderId) {
  const note = db.saveNote("Synced note", "server text", "personal", null, null, folderId).note;
  db.markNoteSynced(note.id, "cloud-1");
  return db.getNote(note.id);
}

function assertTakesServerCopy(db, noteId) {
  const restored = db.restoreNoteAfterDeniedDelete(noteId);
  assert.equal(restored.success, true);
  assert.equal(restored.pending, undefined, "not revived as an edit");
  const row = noteRow(db, noteId);
  assert.equal(row.deleted_at, null);
  assert.equal(row.sync_status, "synced", "nothing for a push to send");
  assert.equal(row.updated_at, "1970-01-01 00:00:00", "so the snapshot pull replaces it");
}

test("a deleted note a later folder delete unfiled takes the server's copy when denied", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(OWNER);
  // A folder the server never saw.
  const folder = db.createFolder("Local only", db.getDefaultPrivateSpaceId()).folder;
  const note = syncedNoteIn(db, folder.id);
  assert.equal(db.deleteNote(note.id).success, true);
  // Some time passes before the folder goes too.
  db.db
    .prepare(
      "UPDATE notes SET deleted_at = '2026-11-01 10:00:00', updated_at = '2026-11-01 10:00:00' WHERE id = ?"
    )
    .run(note.id);

  assert.equal(db.deleteFolder(folder.id).success, true);
  const tombstone = noteRow(db, note.id);
  assert.ok(tombstone.deleted_at, "still a tombstone");
  assert.equal(tombstone.folder_id, null, "out of the folder");
  assert.equal(tombstone.updated_at, "2026-11-01 10:00:00", "and not written to");

  assertTakesServerCopy(db, note.id);
});

test("a pull landing on a note deleted meanwhile doesn't make a denied delete keep it", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(OWNER);
  const note = syncedNoteIn(db, null);
  assert.equal(db.deleteNote(note.id).success, true);
  // The pull read it live before the delete and stores the server's row now.
  db.upsertNoteFromCloud(
    {
      id: "cloud-1",
      client_note_id: note.client_note_id,
      title: note.title,
      content: "server text",
      note_type: "personal",
      created_at: "2026-11-01T09:00:00.000Z",
      updated_at: "2026-11-01T10:00:00.000Z",
    },
    null,
    note.space_id
  );
  const tombstone = noteRow(db, note.id);
  assert.ok(tombstone.deleted_at, "its delete still goes out");
  assert.notEqual(tombstone.updated_at, tombstone.deleted_at);

  assertTakesServerCopy(db, note.id);
});

test("a kept transcript still revives pending after a folder delete touched its tombstone", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(OWNER);
  const folder = db.createFolder("Local only", db.getDefaultPrivateSpaceId()).folder;
  const note = syncedNoteIn(db, folder.id);
  assert.equal(db.deleteNote(note.id).success, true);
  assert.equal(db.keepTranscriptOnDeletedNote(note.id, FINAL).success, true);
  assert.equal(db.deleteFolder(folder.id).success, true);

  const restored = db.restoreNoteAfterDeniedDelete(note.id);
  assert.equal(restored.pending, true);
  const row = noteRow(db, note.id);
  assert.equal(row.transcript, FINAL);
  assert.equal(row.sync_status, "pending");
  assert.equal(row.restore_pending, 0, "the mark goes with the restore");

  // Deleted again, with nothing kept this time: the server's copy.
  assert.equal(db.deleteNote(note.id).success, true);
  assertTakesServerCopy(db, note.id);
});
