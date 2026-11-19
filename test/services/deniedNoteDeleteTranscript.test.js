const test = require("node:test");
const assert = require("node:assert/strict");
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
