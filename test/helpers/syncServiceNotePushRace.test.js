// A device must never race itself on one note. While a meeting records into a
// note, its debounced push and a full sync pass both PATCH it; sent together
// they carry the same base revision, the server takes one and answers the
// other 409, and that 409 used to park the note behind a conflict banner for
// good, with the cloud stuck on an early snapshot. These tests drive the real
// SyncService against a fake cloud that keeps revisions like the server does.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  localStorage: localStorageStub,
  navigator: navigatorStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { deferred } = require("./harness/deferred.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const {
  addNoteConflict,
  readNoteConflictIds,
  readNoteConflicts,
} = require("../../src/lib/noteConflictRegistry.ts");

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  // The revisioned server guards writes by base_revision; its client
  // updated_at is a hint, not a guard.
  const cloud = createFakeCloud({ revisionGuard: true, staleWriteGuard: false });
  const api = createElectronApi(db, { cloud });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, cloud, api, service };
}

// The editor's save path, so the edit carries its field intent as a real one does.
function edit(db, id, content) {
  assert.equal(db.updateNote(id, { content }).success, true);
  const note = db.getNote(id);
  assert.equal(note.sync_status, "pending");
  return note;
}

const isNotePatch = (options) => options.method === "PATCH" && options.path === "/api/notes/update";
const isNoteCreate = (options) =>
  options.method === "POST" &&
  (options.path === "/api/notes/create" || options.path === "/api/notes/batch-create");

// Holds the first request `match` accepts until released. With commitFirst the
// fake cloud applies it before the hold, like a write the server committed
// whose answer is still on the wire.
function holdRequest(api, match, { commitFirst = false } = {}) {
  const forward = api.cloudApiRequest;
  const arrived = deferred();
  const release = deferred();
  let taken = false;
  api.cloudApiRequest = async (options) => {
    if (taken || !match(options)) return forward(options);
    taken = true;
    if (commitFirst) {
      const answer = await forward(options);
      arrived.resolve();
      await release.promise;
      return answer;
    }
    arrived.resolve();
    await release.promise;
    return forward(options);
  };
  return { arrived: arrived.promise, release: () => release.resolve() };
}

// Lets a second push run as far as it can before the held request answers.
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function syncedNote(ctx, content = "first line") {
  const note = ctx.db.saveNote("Standup", content, "meeting").note;
  await ctx.service.syncAll(true);
  const synced = ctx.db.getNote(note.id);
  assert.ok(synced.cloud_id, "the note reaches the cloud");
  assert.equal(synced.cloud_revision, 0);
  assert.equal(synced.sync_status, "synced");
  return synced;
}

test("a debounced push and a full pass never send one note's base twice", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const note = await syncedNote(ctx);

  edit(db, note.id, "first line\nsecond line");
  const held = holdRequest(api, isNotePatch);
  const debounced = service.pushNote(note.id);
  await held.arrived;
  // The recording keeps writing while that PATCH is on the wire.
  edit(db, note.id, "first line\nsecond line\nthird");
  const pass = service.pushPendingNotes(false);
  await settle();
  held.release();
  await Promise.all([debounced, pass]);

  assert.equal(readNoteConflictIds().size, 0, "this device's own write is not a conflict");
  assert.deepEqual(
    cloud.logFor("/api/notes/update").map((call) => call.body.base_revision),
    [0, 1],
    "the second push waits for the first and sends the base it left"
  );
  assert.equal(cloud.note(note.cloud_id).content, "first line\nsecond line\nthird");
  assert.equal(db.getNote(note.id).sync_status, "synced");
  assert.equal(db.getNote(note.id).cloud_revision, 2);
});

// The reported setup: a Free account, so no backup and only team passes, and a
// note in a team space. The fake cloud keeps no spaces, so this serves the one
// space and files every listed note in it.
async function freeTeamNote(ctx) {
  const { db, api, service } = ctx;
  localStorageStub.removeItem("cloudBackupEnabled");
  localStorageStub.removeItem("isSubscribed");
  assert.equal(service.canSync(), false, "its passes are team-only");
  db.setActiveAccountId("user-harness");
  const space = {
    id: "cloud-space",
    workspace_id: "workspace",
    name: "Team",
    slug: "team",
    description: null,
    emoji: null,
    my_role: "member",
    my_direct_role: "member",
    member_count: 2,
    teams: [],
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
  };
  const localSpace = db.upsertSpaceFromCloud(space);
  db.setSpaceSyncStatus(localSpace.id, "synced");
  const forward = api.cloudApiRequest;
  api.cloudApiRequest = async (options) => {
    if (options.path === "/api/me/spaces") return { success: true, data: { data: [space] } };
    const response = await forward(options);
    if (!options.path.startsWith("/api/notes/list") || !response.success) return response;
    const notes = response.data.notes.map((note) => ({
      ...note,
      space_id: space.id,
      user_id: "user-harness",
    }));
    return { ...response, data: { notes } };
  };

  const note = db.saveNote(
    "Standup",
    "first line",
    "meeting",
    null,
    null,
    null,
    localSpace.id
  ).note;
  await service.syncAll(true);
  const synced = db.getNote(note.id);
  assert.ok(synced.cloud_id, "the team note reaches the cloud");
  assert.equal(synced.cloud_revision, 0);
  assert.equal(synced.sync_status, "synced");
  return synced;
}

test("a Free account's team note never sends one base twice, in either order", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const note = await freeTeamNote(ctx);
  const bases = () => cloud.logFor("/api/notes/update").map((call) => call.body.base_revision);

  // A debounced push is out when the team pass reaches the note.
  edit(db, note.id, "first line\nsecond line");
  let held = holdRequest(api, isNotePatch);
  const debounced = service.pushNote(note.id);
  await held.arrived;
  edit(db, note.id, "first line\nsecond line\nthird");
  const pass = service.syncAll(true);
  await settle();
  held.release();
  await Promise.all([debounced, pass]);
  assert.deepEqual(bases(), [0, 1]);

  // The team pass is out when a debounced push of the same text comes due:
  // the pass has sent it, so the push has nothing left to send.
  edit(db, note.id, "first line\nsecond line\nthird\nfourth");
  held = holdRequest(api, isNotePatch);
  const nextPass = service.syncAll(true);
  await held.arrived;
  const queued = service.pushNote(note.id);
  await settle();
  held.release();
  await Promise.all([nextPass, queued]);
  assert.deepEqual(bases(), [0, 1, 2], "no PATCH without content follows the pass's");

  assert.equal(readNoteConflictIds().size, 0);
  assert.equal(cloud.note(note.cloud_id).content, "first line\nsecond line\nthird\nfourth");
  assert.equal(db.getNote(note.id).sync_status, "synced");
  assert.equal(db.getNote(note.id).cloud_revision, 3);
});

test("a debounced create and a full pass create a new note once", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const note = db.saveNote("Standup", "first line", "meeting").note;

  const held = holdRequest(api, isNoteCreate);
  const debounced = service.pushNote(note.id);
  await held.arrived;
  edit(db, note.id, "first line\nsecond line");
  const pass = service.pushPendingNotes(false);
  await settle();
  held.release();
  await Promise.all([debounced, pass]);

  const creates = cloud.log.filter((call) => isNoteCreate(call));
  assert.equal(creates.length, 1, "the pass waits and finds the note already created");
  const created = db.getNote(note.id);
  assert.ok(created.cloud_id);
  assert.equal(created.cloud_create_rejected, 0);

  // The text written during the create still goes out, as an update.
  await service.pushPendingNotes(false);
  assert.equal(cloud.notes().length, 1);
  assert.equal(cloud.note(created.cloud_id).content, "first line\nsecond line");
  assert.equal(db.getNote(note.id).sync_status, "synced");
  assert.equal(readNoteConflictIds().size, 0);
});

test("a pull that reads this device's write before its answer raises no conflict", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const note = await syncedNote(ctx);

  edit(db, note.id, "first line\nsecond line");
  const held = holdRequest(api, isNotePatch, { commitFirst: true });
  const debounced = service.pushNote(note.id);
  await held.arrived;
  assert.equal(cloud.note(note.cloud_id).revision, 1, "the server already holds the write");
  edit(db, note.id, "first line\nsecond line\nthird");
  const pull = service.pullNotes(false, true);
  await settle();
  held.release();
  await Promise.all([debounced, pull]);

  assert.equal(readNoteConflictIds().size, 0, "the newer cloud row was this device's own");
  const local = db.getNote(note.id);
  assert.equal(local.content, "first line\nsecond line\nthird", "the newest local text stays");
  assert.equal(local.cloud_revision, 1);

  await service.pushPendingNotes(false);
  assert.equal(cloud.note(note.cloud_id).content, "first line\nsecond line\nthird");
  assert.equal(db.getNote(note.id).sync_status, "synced");
});

// What 1.11.0 left behind after the race: the losing push parked the note with
// the winner's row as its "newer" copy, and the winner's answer then moved the
// note's base to that very revision.
async function selfConflictedNote(ctx) {
  const { db, cloud, service } = ctx;
  const note = await syncedNote(ctx);
  edit(db, note.id, "first line\nsecond line");
  await service.pushPendingNotes(false);
  assert.equal(db.getNote(note.id).cloud_revision, 1);
  const own = cloud.note(note.cloud_id);
  edit(db, note.id, "first line\nsecond line\nthird");
  addNoteConflict(note.client_note_id, own);
  return note;
}

test("a full pass settles a conflict left by this device's own write and pushes", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const note = await selfConflictedNote(ctx);

  await service.pushPendingNotes(false);

  assert.equal(readNoteConflictIds().size, 0);
  assert.equal(cloud.note(note.cloud_id).content, "first line\nsecond line\nthird");
  assert.equal(db.getNote(note.id).sync_status, "synced");
});

test("a debounced push settles a conflict left by this device's own write", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const note = await selfConflictedNote(ctx);

  await service.pushNote(note.id);

  assert.equal(readNoteConflictIds().size, 0);
  assert.equal(cloud.note(note.cloud_id).content, "first line\nsecond line\nthird");
  assert.equal(db.getNote(note.id).sync_status, "synced");
});

test("another device's newer write still waits for Keep or Refresh", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const note = await syncedNote(ctx);

  // A teammate's edit lands first, from the same base this device holds.
  await cloud.request({
    method: "PATCH",
    path: "/api/notes/update",
    body: { id: note.cloud_id, content: "their line", base_revision: 0 },
  });
  const theirs = cloud.note(note.cloud_id);
  assert.equal(theirs.revision, 1);
  edit(db, note.id, "my line");
  addNoteConflict(note.client_note_id, theirs);
  const patches = cloud.logFor("/api/notes/update").length;

  await service.pushPendingNotes(false);
  await service.pushNote(note.id);

  assert.equal(cloud.logFor("/api/notes/update").length, patches, "nothing is pushed over it");
  assert.equal(readNoteConflicts()[note.client_note_id]?.revision, 1, "the banner stays");
  assert.equal(cloud.note(note.cloud_id).content, "their line");
  assert.equal(db.getNote(note.id).content, "my line");
});

test("a racing 409 from another device still surfaces its conflict", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const note = await syncedNote(ctx);

  edit(db, note.id, "my line");
  await cloud.request({
    method: "PATCH",
    path: "/api/notes/update",
    body: { id: note.cloud_id, content: "their line", base_revision: 0 },
  });

  await service.pushNote(note.id);

  assert.equal(readNoteConflicts()[note.client_note_id]?.content, "their line");
  assert.equal(db.getNote(note.id).sync_status, "pending");
});

test("a debounced push that never hears back holds up a pass only so long", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const note = await syncedNote(ctx);

  edit(db, note.id, "first line\nsecond line");
  const held = holdRequest(api, isNotePatch);
  const debounced = service.pushNote(note.id);
  await held.arrived;
  edit(db, note.id, "first line\nsecond line\nthird");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let passDone = false;
  const pass = service.pushPendingNotes(false).then(() => {
    passDone = true;
  });
  await settle();
  t.mock.timers.tick(10_000);
  await settle();

  assert.ok(passDone, "the pass leaves the note to the next one");
  assert.equal(cloud.logFor("/api/notes/update").length, 0, "nothing goes out over the held push");
  assert.equal(db.getNote(note.id).sync_status, "pending");
  assert.equal(readNoteConflictIds().size, 0);
  held.release();
  await Promise.all([debounced, pass]);
});

// A refused edit forks the note to Personal, then a pull brings the server's
// copy back. That pull takes note locks, so it must run with this one free.
for (const via of ["debounced push", "full pass"]) {
  test(`a ${via} refused by the server keeps the edit and restores the server copy`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    const note = await syncedNote(ctx);
    edit(db, note.id, "my line");
    cloud.failNext(isNotePatch, { status: 403, code: "note_access_denied" });
    let lockFreeDuringRestore = null;
    const forward = api.cloudApiRequest;
    api.cloudApiRequest = async (options) => {
      if (lockFreeDuringRestore === null && options.path.startsWith("/api/notes/list")) {
        lockFreeDuringRestore = await navigatorStub.locks.request(
          `openwhispr-note-push:${note.id}`,
          { ifAvailable: true },
          (lock) => lock !== null
        );
      }
      return forward(options);
    };

    if (via === "debounced push") await service.pushNote(note.id);
    else await service.pushPendingNotes(false);

    assert.equal(lockFreeDuringRestore, true, "the restoring pull runs once the lock is free");
    const fork = db.getNote(note.id);
    assert.equal(fork.content, "my line");
    assert.equal(fork.cloud_id, null);
    assert.notEqual(fork.client_note_id, note.client_note_id);
    assert.equal(db.getNoteByClientId(note.client_note_id)?.content, "first line");
  });
}
