const test = require("node:test");
const assert = require("node:assert/strict");
const { createSyncDevice } = require("../helpers/harness/syncDevice.js");
const { createAccountCloud } = require("../helpers/harness/fakeCloud.js");
const { TEAM_ACCOUNT, TEAM_SPACE, joinTeamSpace } = require("../helpers/harness/teamSpace.js");

// A pull decides whether a note deleted elsewhere (or one whose team access is
// gone) is clean, then deletes it a few awaits later. A save that lands in
// between (the editor's debounced save, a recording's periodic save) is told it
// succeeded, so nothing in the renderer rescues it: the delete must leave it.

const TYPED = "typed in the last second";

const holding = (db, text) =>
  db.db
    .prepare("SELECT id, client_note_id, cloud_id, deleted_at FROM notes WHERE content LIKE ?")
    .all(`%${text}%`);
const noteRow = (db, id) => db.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) ?? null;

// Runs `write` just before the note's first hard delete reaches main, and counts
// the deletes after it.
function writeBeforeDelete(device, noteId, write) {
  const original = device.api.hardDeleteNote;
  const calls = [];
  device.api.hardDeleteNote = async (id, generation, options) => {
    if (id === noteId && calls.length === 0) calls.push(write());
    else if (id === noteId) calls.push(null);
    return original(id, generation, options);
  };
  return calls;
}

async function deletedElsewhere(t) {
  const device = createSyncDevice(t);
  if (!device) return null;
  const cloud = createAccountCloud({ revisionGuard: true });
  await device.signIn("owner", cloud);
  const spaceId = device.db.getDefaultPrivateSpaceId();
  const note = device.db.saveNote(
    "Standup",
    "pushed text",
    "personal",
    null,
    null,
    null,
    spaceId
  ).note;
  await device.service.syncAll(true);
  const cloudId = device.db.getNote(note.id).cloud_id;
  assert.ok(cloudId);
  // Another device deletes it.
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: cloudId } });
  return { device, cloud, noteId: note.id, cloudId };
}

test("a save landing just before a pulled delete keeps its text as a note of its own", async (t) => {
  const ctx = await deletedElsewhere(t);
  if (!ctx) return;
  const { device, cloud, noteId, cloudId } = ctx;
  const original = noteRow(device.db, noteId);
  const calls = writeBeforeDelete(device, noteId, () =>
    device.db.updateNote(noteId, { content: TYPED })
  );

  await device.service.syncAll(true);

  assert.equal(calls[0]?.success, true, "the save was told it succeeded");
  const kept = holding(device.db, TYPED);
  assert.equal(kept.length, 1, "its text is still on the device");
  assert.equal(kept[0].deleted_at, null);
  assert.notEqual(kept[0].client_note_id, original.client_note_id, "as a note of its own");
  assert.ok(cloud.note(cloudId).deleted_at, "the deleted note stays deleted");

  await device.service.syncAll(true);
  const uploaded = cloud.notes().filter((row) => !row.deleted_at && row.content === TYPED);
  assert.equal(uploaded.length, 1, "and the next pass backs it up");
});

test("a clean copy of a note deleted elsewhere still goes", async (t) => {
  const ctx = await deletedElsewhere(t);
  if (!ctx) return;
  const { device, noteId } = ctx;

  await device.service.syncAll(true);

  assert.equal(noteRow(device.db, noteId), null);
});

test("this device's own delete, written to while the pull decided, still goes", async (t) => {
  const ctx = await deletedElsewhere(t);
  if (!ctx) return;
  const { device, cloud, noteId } = ctx;
  assert.equal(device.db.deleteNote(noteId).success, true);
  // Its own delete request gets no answer, so the pull is the one to apply it.
  cloud.failNext("DELETE /api/notes/delete", { status: 500, error: "offline" });
  // The recording's stop keeps its transcript on the tombstone meanwhile.
  const calls = writeBeforeDelete(device, noteId, () =>
    device.db.keepTranscriptOnDeletedNote(noteId, "said after the delete")
  );

  await device.service.syncAll(true);

  assert.equal(calls[0]?.success, true);
  assert.equal(calls.length, 2, "read again and deleted");
  assert.equal(noteRow(device.db, noteId), null);
});

async function teamNoteLosingAccess(t) {
  const device = createSyncDevice(t);
  if (!device) return null;
  const cloud = createAccountCloud();
  await device.signIn(TEAM_ACCOUNT, cloud);
  const team = joinTeamSpace(device.db, cloud, { fileRowsHere: false });
  const row = cloud.seedNote({
    title: "Moved away",
    content: "team body",
    space_id: TEAM_SPACE.id,
    workspace_id: TEAM_SPACE.workspace_id,
    user_id: TEAM_ACCOUNT,
  });
  const local = device.db.upsertNoteFromCloud(row, null, team.id);
  assert.equal(local.sync_status, "synced");
  // The note moved out of the team: the list answers with its access stub.
  const send = cloud.request;
  cloud.request = async (opts) => {
    const answer = await send(opts);
    if (!opts.path.startsWith("/api/notes/list") || !answer.success) return answer;
    return {
      ...answer,
      data: {
        notes: answer.data.notes.map((note) =>
          note.id === row.id
            ? {
                id: note.id,
                client_note_id: note.client_note_id,
                space_id: null,
                previous_space_id: note.space_id ?? null,
                access_removed: true,
                updated_at: "2026-07-22T00:00:00.000Z",
              }
            : note
        ),
      },
    };
  };
  return { device, noteId: local.id, clientNoteId: local.client_note_id };
}

test("a save landing just before an access stub's delete moves the note to Private", async (t) => {
  const ctx = await teamNoteLosingAccess(t);
  if (!ctx) return;
  const { device, noteId, clientNoteId } = ctx;
  const calls = writeBeforeDelete(device, noteId, () =>
    device.db.updateNote(noteId, { content: TYPED })
  );

  await device.service.syncAll(true);

  assert.equal(calls[0]?.success, true, "the save was told it succeeded");
  const kept = noteRow(device.db, noteId);
  assert.ok(kept, "the note is still on the device");
  assert.equal(kept.content, TYPED);
  assert.equal(kept.deleted_at, null);
  assert.equal(kept.space_id, device.db.getPrivateSpaceId(TEAM_SPACE.workspace_id));
  assert.notEqual(kept.client_note_id, clientNoteId);
});

test("a clean copy of a note whose team access is gone still goes", async (t) => {
  const ctx = await teamNoteLosingAccess(t);
  if (!ctx) return;
  const { device, noteId } = ctx;

  await device.service.syncAll(true);

  assert.equal(noteRow(device.db, noteId), null);
});
