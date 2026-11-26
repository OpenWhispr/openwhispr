const test = require("node:test");
const assert = require("node:assert/strict");
const { createSyncDevice } = require("../helpers/harness/syncDevice.js");
const { createAccountCloud } = require("../helpers/harness/fakeCloud.js");
const { localStorage: storage } = require("../helpers/harness/browserGlobals.js");
const { readNoteConflicts } = require("../../src/lib/noteConflictRegistry.ts");

// A server write stamps its rows with its transaction's start but shows them only
// at commit. A pull that ran in between stored a cursor past rows it never saw;
// these tests put the cursor there directly.

async function setup(t, config = {}) {
  const device = createSyncDevice(t);
  if (!device) return null;
  const cloud = createAccountCloud(config);
  await device.signIn("overlap-owner", cloud);
  return { device, cloud, spaceId: device.db.getDefaultPrivateSpaceId() };
}

const noteRow = (db, id) => db.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) ?? null;
const folderRow = (db, id) => db.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) ?? null;
const allRows = (db) => ({
  notes: db.db.prepare("SELECT * FROM notes ORDER BY id").all(),
  folders: db.db.prepare("SELECT * FROM folders ORDER BY id").all(),
});
const justAfter = (iso) => new Date(Date.parse(iso) + 1).toISOString();
const sinceOf = (call) => new URLSearchParams(call.path.split("?")[1] ?? "").get("since");

test("a note delete committed behind the note cursor removes the note its folder's delete kept", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud, spaceId } = ctx;
  const folder = device.db.createFolder("Client", spaceId).folder;
  const note = device.db.saveNote(
    "Deleted elsewhere",
    "secret body",
    "personal",
    null,
    null,
    folder.id,
    spaceId
  ).note;
  await device.service.syncAll(true);
  const cloudFolderId = folderRow(device.db, folder.id).cloud_id;
  const cloudNoteId = noteRow(device.db, note.id).cloud_id;
  assert.ok(cloudFolderId && cloudNoteId);

  // Another device deletes the folder: the server tombstones its notes with it.
  await cloud.request({
    method: "DELETE",
    path: "/api/folders/delete",
    body: { id: cloudFolderId },
  });
  const tombstone = cloud.note(cloudNoteId);
  assert.ok(tombstone.deleted_at);
  // The last note pull ran inside that write: its cursor passed the tombstone.
  storage.setItem("lastSyncedAt.notes", justAfter(tombstone.updated_at));

  await device.service.syncAll(true);
  assert.equal(folderRow(device.db, folder.id), null, "the folder delete applied");
  assert.equal(noteRow(device.db, note.id), null, "the note delete applied too");

  for (let pass = 0; pass < 4; pass++) await device.service.syncAll(true);
  assert.deepEqual(
    cloud.notes().filter((row) => !row.deleted_at),
    [],
    "the note never comes back as a new cloud note"
  );
});

test("a folder delete committed behind the folder cursor still applies", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud, spaceId } = ctx;
  const folder = device.db.createFolder("Old project", spaceId).folder;
  await device.service.syncAll(true);
  const cloudFolderId = folderRow(device.db, folder.id).cloud_id;
  assert.ok(cloudFolderId);

  await cloud.request({
    method: "DELETE",
    path: "/api/folders/delete",
    body: { id: cloudFolderId },
  });
  storage.setItem("lastSyncedAt.folders", justAfter(cloud.folder(cloudFolderId).updated_at));

  await device.service.syncAll(true);
  assert.equal(folderRow(device.db, folder.id), null);
});

test("re-reading applied rows from the overlap changes nothing and moves no work", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { device, cloud, spaceId } = ctx;
  const folder = device.db.createFolder("Planning", spaceId).folder;
  const filed = device.db.saveNote(
    "Filed",
    "in a folder",
    "personal",
    null,
    null,
    folder.id,
    spaceId
  ).note;
  const edited = device.db.saveNote(
    "Edited",
    "first text",
    "personal",
    null,
    null,
    null,
    spaceId
  ).note;
  // The first pass uploads the default folder after its folder pull; the second reads it.
  await device.service.syncAll(true);
  await device.service.syncAll(true);
  const editedCloudId = noteRow(device.db, edited.id).cloud_id;
  assert.ok(noteRow(device.db, filed.id).cloud_id && editedCloudId);

  // A local edit not pushed yet, stamped by a device clock running behind the server's.
  device.db.updateNote(edited.id, { content: "newer local text" });
  const base = noteRow(device.db, edited.id).cloud_updated_at;
  device.db.db
    .prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
    .run(new Date(Date.parse(base) - 30_000).toISOString(), edited.id);

  const before = allRows(device.db);
  const logLength = cloud.log.length;
  device.service.teamPassMovedWork = false;
  assert.equal(await device.service.pullFolders(), true);
  assert.equal(await device.service.pullNotes(), true);

  // Both deltas really re-read the rows: each started before every row's stamp.
  const lists = cloud.log.slice(logLength).filter((call) => call.method === "GET");
  const noteSince = sinceOf(lists.find((call) => call.path.startsWith("/api/notes/list")));
  const folderSince = sinceOf(lists.find((call) => call.path.startsWith("/api/folders/list")));
  assert.ok(Date.parse(noteSince) < Date.parse(storage.getItem("lastSyncedAt.notes")));
  for (const row of cloud.notes()) assert.ok(Date.parse(row.updated_at) > Date.parse(noteSince));
  for (const row of cloud.folders()) {
    assert.ok(Date.parse(row.updated_at) > Date.parse(folderSince));
  }

  assert.deepEqual(allRows(device.db), before, "no local write");
  assert.deepEqual(readNoteConflicts(), {}, "no conflict");
  assert.deepEqual(
    cloud.log.slice(logLength).filter((call) => call.method !== "GET"),
    [],
    "nothing sent"
  );
  assert.equal(device.service.teamPassMovedWork, false, "an idle pass still backs off");

  // A row past the cursor is work, and applies.
  await cloud.request({
    method: "PATCH",
    path: "/api/notes/update",
    body: {
      id: noteRow(device.db, filed.id).cloud_id,
      content: "edited on another device",
      updated_at: justAfter(storage.getItem("lastSyncedAt.notes")),
    },
  });
  assert.equal(await device.service.pullNotes(), true);
  assert.equal(device.service.teamPassMovedWork, true);
  assert.equal(noteRow(device.db, filed.id).content, "edited on another device");
  assert.equal(noteRow(device.db, edited.id).content, "newer local text");
});
