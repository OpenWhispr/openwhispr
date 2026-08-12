// Whole-pass kill chains: the real SyncService drives the real service stack over
// one real SQLite database per device, with the fake cloud as the only boundary.
// Each scenario is a story a user could tell end to end, and every one of them
// finishes on the content-regression invariant.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  establishValidatedAuth,
  stopSyncTimers,
  localStorage: browserLocalStorage,
  window: browserWindow,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { assertNoContentRegression, snapshotNotes } = require("./harness/invariants.js");
const { SyncService } = require("../../src/services/SyncService.ts");

installBrowserGlobals();

// Mirrors BATCH_SIZE in SyncService.ts.
const BATCH_SIZE = 50;
const CAN_SYNC = { isSignedIn: "true", cloudBackupEnabled: "true", isSubscribed: "true" };

// SQLite's datetime() shape, which is what local rows actually carry. Every
// timestamp in this file is pinned by SQL; nothing here waits or fakes a clock.
const T_SHELL = "2026-07-20 10:00:00";
const T_TRANSCRIPT = "2026-07-20 11:00:00";
const T_PEER = "2026-07-20 13:00:00";
const T_FUTURE = "2027-01-01 00:00:00";

// S2 keeps its sync cursors across every relaunch, so its edits have to be newer
// than the wall-clock stamp a completed pass leaves behind, as real edits are.
const F_SHELL = "2027-03-01 10:00:00";
const F_TITLE = "2027-03-01 10:30:00";
const F_TRANSCRIPT = "2027-03-01 11:00:00";

function iso(sqliteTimestamp) {
  return `${sqliteTimestamp.replace(" ", "T")}.000Z`;
}

function shift(isoString, hours) {
  return new Date(Date.parse(isoString) + hours * 3600_000).toISOString();
}

function queryParam(path, name) {
  const [, query] = path.split("?");
  return new URLSearchParams(query ?? "").get(name);
}

function silenceConsoleErrors(t) {
  t.mock.method(console, "error", () => {});
}

// The incident's payload was a real meeting transcript, not a token string; a
// small body would not exercise the same batch and clone paths.
function largeBody(label) {
  return `${label} speaker turn long enough to make the payload realistic. `.repeat(1000);
}

function readStorage() {
  const values = {};
  for (let i = 0; i < browserLocalStorage.length; i += 1) {
    const key = browserLocalStorage.key(i);
    values[key] = browserLocalStorage.getItem(key);
  }
  return values;
}

function writeStorage(values) {
  browserLocalStorage.clear();
  for (const [key, value] of Object.entries(values)) browserLocalStorage.setItem(key, value);
}

function freshCloud(config) {
  resetBrowserGlobals();
  return createFakeCloud(config);
}

// One machine: its own SQLite file and its own localStorage, sharing the cloud.
// Devices never see each other's cursors, which is the whole point of S2.
function createDevice(t, cloud) {
  const db = createDb(t);
  if (!db) return null;
  return { db, api: createElectronApi(db, { cloud }), storage: { ...CAN_SYNC } };
}

// One app launch: the device's stored localStorage comes back, its IPC surface is
// installed, and a brand new SyncService runs against them.
async function launch(device, body) {
  writeStorage(device.storage);
  browserWindow.electronAPI = device.api;
  // Every launch re-validates the session, exactly as the renderer does.
  await establishValidatedAuth();
  const service = new SyncService();
  try {
    return await body(service);
  } finally {
    stopSyncTimers(service);
    device.storage = readStorage();
  }
}

function syncOnce(device) {
  return launch(device, (service) => service.syncAll(true));
}

// A relaunch onto a wiped profile: the database survives, every sync cursor is
// gone, so the next pull starts from the full snapshot again.
function wipeCursors(device) {
  device.storage = { ...CAN_SYNC };
}

function setNoteRow(db, id, columns) {
  const keys = Object.keys(columns);
  db.db
    .prepare(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => columns[k]), id);
  return db.getNote(id);
}

function noteByClientId(db, clientNoteId) {
  return db.db.prepare("SELECT * FROM notes WHERE client_note_id = ?").get(clientNoteId) ?? null;
}

function noteCount(db) {
  return db.db.prepare("SELECT COUNT(*) AS c FROM notes").get().c;
}

function folderByName(db, name) {
  return db.db.prepare("SELECT * FROM folders WHERE name = ?").get(name) ?? null;
}

// A local row already bound to a cloud note, exactly as an earlier pull left it.
function linkLocalNote(db, cloudRow, title, content) {
  const local = db.saveNote(title, content, "personal").note;
  return setNoteRow(db, local.id, {
    client_note_id: cloudRow.client_note_id,
    cloud_id: cloudRow.id,
    sync_status: "synced",
    created_at: cloudRow.created_at,
    updated_at: cloudRow.updated_at,
  });
}

test("S1 a meeting shell that gains a large transcript survives a relaunch and reaches the cloud", async (t) => {
  const cloud = freshCloud();
  const device = createDevice(t, cloud);
  if (!device) return;
  const { db } = device;

  // Byte-faithful to meetingDetectionEngine.js: saveNote(eventSummary, "", "meeting").
  const eventSummary = "Weekly Product Sync";
  const shell = db.saveNote(eventSummary, "", "meeting").note;
  setNoteRow(db, shell.id, { created_at: T_SHELL, updated_at: T_SHELL });

  await syncOnce(device);

  const cloudId = db.getNote(shell.id).cloud_id;
  assert.ok(cloudId, "the shell must reach the cloud on the first pass");
  assert.equal(cloud.note(cloudId).content, "", "the shell goes up empty, because it is empty");

  // Transcription lands after the shell was already synced, so the row is pending
  // again while carrying a cloud_id. That combination is the migration shape.
  const content = largeBody("cleaned");
  const transcript = largeBody("raw");
  assert.ok(content.length > 60000, "the payload must be the incident's size");
  db.updateNote(shell.id, { content, transcript });
  setNoteRow(db, shell.id, { updated_at: T_TRANSCRIPT });
  assert.equal(db.getNote(shell.id).sync_status, "pending");

  const before = snapshotNotes(db);
  wipeCursors(device);
  await launch(device, async (service) => {
    await service.syncAll(true);
    await service.syncAll(true);
  });

  const row = db.getNote(shell.id);
  assert.equal(row.content, content, "the local body must survive the relaunch untouched");
  assert.equal(row.transcript, transcript);
  assert.equal(row.title, eventSummary);
  assert.equal(row.sync_status, "synced");
  assert.equal(row.cloud_id, cloudId, "the note keeps its cloud identity across the relaunch");

  const remote = cloud.note(cloudId);
  assert.equal(remote.content, content, "the cloud must end up holding the transcript");
  assert.equal(remote.transcript, transcript);
  assert.equal(cloud.notes().length, 1, "two passes must not fork a second cloud note");

  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("S1 the same migration holds the line on a legacy cloud with a stale peer overwriting it", async (t) => {
  const cloud = freshCloud({
    materialPatchGate: false,
    coalesceOnConflict: false,
    staleWriteGuard: false,
    updatedAtClamp: false,
  });
  const device = createDevice(t, cloud);
  if (!device) return;
  const { db } = device;

  const shell = db.saveNote("Weekly Product Sync", "", "meeting").note;
  setNoteRow(db, shell.id, { created_at: T_SHELL, updated_at: T_SHELL });
  await syncOnce(device);
  const cloudId = db.getNote(shell.id).cloud_id;
  assert.ok(cloudId);

  const content = largeBody("cleaned");
  const transcript = largeBody("raw");
  db.updateNote(shell.id, { content, transcript });
  setNoteRow(db, shell.id, { updated_at: T_TRANSCRIPT });

  wipeCursors(device);
  await syncOnce(device);

  assert.equal(
    cloud.note(cloudId).content,
    content,
    "the client's full-content PATCH must not depend on the server's no-op gate"
  );

  // A second device still on the pre-fix build pushes its own copy of the shell:
  // empty, and on a legacy server that write lands and wins the timestamp.
  const peer = await cloud.request({
    method: "PATCH",
    path: "/api/notes/update",
    body: { id: cloudId, content: "", transcript: null, updated_at: iso(T_PEER) },
  });
  assert.equal(peer.success, true);
  assert.equal(cloud.note(cloudId).content, "", "the legacy server accepted the empty overwrite");

  const before = snapshotNotes(db);
  wipeCursors(device);
  await syncOnce(device);

  const row = db.getNote(shell.id);
  assert.equal(
    row.content,
    content,
    "a strictly newer but empty cloud copy must never replace local text"
  );
  assert.equal(
    row.transcript,
    transcript,
    "an absent cloud transcript must not blank the local one"
  );
  assert.equal(row.updated_at, iso(T_PEER), "the row still accepts the newer copy's timestamp");
  assert.equal(row.sync_status, "synced");
  // The cloud copy stays lost here: recovering it is what the server-side
  // hardening is for, and the desktop's job is to keep the user's text.
  assert.equal(cloud.note(cloudId).content, "");

  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("S2 two devices: an older empty shell never destroys the transcript and the clash surfaces as a conflict", async (t) => {
  const cloud = freshCloud();
  const deviceA = createDevice(t, cloud);
  if (!deviceA) return;
  const deviceB = createDevice(t, cloud);
  if (!deviceB) return;

  const shell = deviceA.db.saveNote("Weekly Product Sync", "", "meeting").note;
  setNoteRow(deviceA.db, shell.id, { created_at: F_SHELL, updated_at: F_SHELL });
  await syncOnce(deviceA);
  const clientNoteId = deviceA.db.getNote(shell.id).client_note_id;
  const cloudId = deviceA.db.getNote(shell.id).cloud_id;

  await syncOnce(deviceB);
  const pulled = noteByClientId(deviceB.db, clientNoteId);
  assert.ok(pulled, "device B must receive the shell through the cloud");
  assert.equal(pulled.content, "");
  assert.equal(pulled.cloud_id, cloudId);

  // B does the recording, so B is the device that actually holds the transcript.
  const content = largeBody("device B cleaned");
  deviceB.db.updateNote(pulled.id, { content });
  setNoteRow(deviceB.db, pulled.id, { updated_at: F_TRANSCRIPT });
  await syncOnce(deviceB);
  assert.equal(cloud.note(cloudId).content, content, "B's transcript must reach the cloud");

  // Meanwhile A, still holding the empty shell, renames it. That re-queues A's row
  // as pending with no content and a basis older than B's upload.
  deviceA.db.updateNote(shell.id, { title: "Weekly Product Sync (rescheduled)" });
  setNoteRow(deviceA.db, shell.id, { updated_at: F_TITLE });

  const beforeA = snapshotNotes(deviceA.db);
  const mark = cloud.log.length;
  await syncOnce(deviceA);

  const patches = cloud.log
    .slice(mark)
    .filter((c) => c.method === "PATCH" && c.path === "/api/notes/update");
  assert.equal(patches.length, 1, "A must attempt exactly one push for its stale shell");
  assert.equal(patches[0].body.content, "", "A really did offer an empty body");
  assert.equal(
    patches[0].body.updated_at,
    F_TITLE,
    "the push must carry A's own older basis, or nothing can reject it as stale"
  );

  assert.equal(cloud.note(cloudId).content, content, "B's transcript must still be in the cloud");
  // A's unpushed rename collided with B's newer cloud copy: the pass surfaces a
  // conflict and leaves both sides intact until the user picks Keep or Refresh,
  // instead of silently electing a winner.
  const rowA = deviceA.db.getNote(shell.id);
  assert.equal(rowA.content, "", "A's local row is not silently overwritten");
  assert.equal(rowA.title, "Weekly Product Sync (rescheduled)", "A keeps its unpushed rename");
  assert.notEqual(rowA.sync_status, "synced", "the row must not settle while the conflict is open");
  const conflicts = JSON.parse(deviceA.storage["noteConflicts.clientIds"] ?? "{}");
  assert.ok(conflicts[clientNoteId], "the conflict must be surfaced for this note");
  assert.equal(
    conflicts[clientNoteId].content,
    content,
    "the registry holds B's cloud copy for the Refresh choice"
  );

  // The conflicted row is gated from later pushes, so A can never clobber B.
  const mark2 = cloud.log.length;
  await syncOnce(deviceA);
  assert.equal(
    cloud.log
      .slice(mark2)
      .filter((c) => c.method === "PATCH" && c.path === "/api/notes/update").length,
    0,
    "a conflicted row must not be re-pushed before the user resolves it"
  );
  assert.equal(cloud.note(cloudId).content, content);

  const beforeB = snapshotNotes(deviceB.db);
  await syncOnce(deviceB);
  assert.equal(noteByClientId(deviceB.db, clientNoteId).content, content, "B keeps its own text");

  assertNoContentRegression(beforeA, snapshotNotes(deviceA.db), cloud.notes());
  assertNoContentRegression(beforeB, snapshotNotes(deviceB.db), cloud.notes());
});

test("S3 a delete travels to the cloud and back down to the other device", async (t) => {
  const cloud = freshCloud();
  const deviceA = createDevice(t, cloud);
  if (!deviceA) return;
  const deviceB = createDevice(t, cloud);
  if (!deviceB) return;

  const note = deviceA.db.saveNote("Shared note", "shared body", "personal").note;
  setNoteRow(deviceA.db, note.id, { created_at: T_SHELL, updated_at: T_SHELL });
  await syncOnce(deviceA);
  const clientNoteId = deviceA.db.getNote(note.id).client_note_id;
  const cloudId = deviceA.db.getNote(note.id).cloud_id;

  await syncOnce(deviceB);
  assert.ok(noteByClientId(deviceB.db, clientNoteId), "B must have the note before it is deleted");
  const bCursor = deviceB.storage["lastSyncedAt.notes"];
  assert.ok(bCursor, "B's first pass must leave a delta cursor");

  // The server stamps the tombstone; wall-clock would land in B's cursor
  // millisecond and the delta page would then hide it.
  cloud.setClock(() => shift(bCursor, 1));
  deviceA.db.deleteNote(note.id);
  const beforeA = snapshotNotes(deviceA.db);
  await syncOnce(deviceA);

  const deletes = cloud.logFor("/api/notes/delete");
  assert.equal(deletes.length, 1, "the delete must reach the cloud exactly once");
  assert.deepEqual(deletes[0].body, { id: cloudId });
  assert.equal(deviceA.db.getNote(note.id), null, "A drops the row only after the cloud ack");
  assert.ok(cloud.note(cloudId).deleted_at, "the cloud row must be tombstoned");

  const beforeB = snapshotNotes(deviceB.db);
  const mark = cloud.log.length;
  await syncOnce(deviceB);

  const lists = cloud.log.slice(mark).filter((c) => c.path.split("?")[0] === "/api/notes/list");
  assert.equal(
    queryParam(lists[0].path, "since"),
    bCursor,
    "only the delta page carries tombstones, so B must send its cursor"
  );
  assert.equal(noteByClientId(deviceB.db, clientNoteId), null, "the delete must reach B");
  assert.equal(noteCount(deviceB.db), 0);

  assertNoContentRegression(beforeA, snapshotNotes(deviceA.db), cloud.notes());
  assertNoContentRegression(beforeB, snapshotNotes(deviceB.db), cloud.notes());
});

test("S3 a delete racing an unsynced edit is won by the cloud tombstone", async (t) => {
  const cloud = freshCloud();
  const deviceA = createDevice(t, cloud);
  if (!deviceA) return;
  const deviceB = createDevice(t, cloud);
  if (!deviceB) return;

  const note = deviceA.db.saveNote("Contested note", "original body", "personal").note;
  setNoteRow(deviceA.db, note.id, { created_at: T_SHELL, updated_at: T_SHELL });
  await syncOnce(deviceA);
  const clientNoteId = deviceA.db.getNote(note.id).client_note_id;
  const cloudId = deviceA.db.getNote(note.id).cloud_id;

  await syncOnce(deviceB);
  const onB = noteByClientId(deviceB.db, clientNoteId);
  assert.ok(onB);
  const bCursor = deviceB.storage["lastSyncedAt.notes"];

  // B edits while offline; A deletes and gets to the cloud first.
  deviceB.db.updateNote(onB.id, { content: "B's late edit that never shipped" });
  setNoteRow(deviceB.db, onB.id, { updated_at: T_TRANSCRIPT });

  cloud.setClock(() => shift(bCursor, 1));
  deviceA.db.deleteNote(note.id);
  await syncOnce(deviceA);
  assert.ok(cloud.note(cloudId).deleted_at);

  const beforeB = snapshotNotes(deviceB.db);
  const mark = cloud.log.length;
  await syncOnce(deviceB);

  const patches = cloud.log
    .slice(mark)
    .filter((c) => c.method === "PATCH" && c.path === "/api/notes/update");
  assert.equal(patches.length, 1, "B still tries to push its edit onto the tombstoned row");
  assert.equal(patches[0].body.content, "B's late edit that never shipped");

  // Documented current behaviour, not a preference: the tombstone wins and the
  // edit that never reached the cloud is destroyed.
  assert.equal(noteByClientId(deviceB.db, clientNoteId), null, "the tombstone removes B's row");
  assert.equal(noteCount(deviceB.db), 0);
  assert.ok(cloud.note(cloudId).deleted_at, "the cloud row stays deleted");

  assertNoContentRegression(beforeB, snapshotNotes(deviceB.db), cloud.notes());
});

test("S4 a quit before the push loses nothing and the next launch uploads the note", async (t) => {
  const cloud = freshCloud();
  const device = createDevice(t, cloud);
  if (!device) return;
  const { db } = device;

  const note = db.saveNote(
    "Recorded then quit",
    "body written just before the quit",
    "personal"
  ).note;
  setNoteRow(db, note.id, { created_at: T_SHELL, updated_at: T_SHELL });
  assert.equal(cloud.log.length, 0, "the quit happened before any request went out");

  const before = snapshotNotes(db);
  wipeCursors(device);
  await syncOnce(device);

  const row = db.getNote(note.id);
  assert.equal(row.sync_status, "synced", "the pending row must be picked up on the next launch");
  assert.ok(row.cloud_id);
  assert.equal(cloud.note(row.cloud_id).content, "body written just before the quit");

  await syncOnce(device);
  assert.equal(cloud.notes().length, 1, "a second launch must not upload the note again");
  assert.equal(cloud.logFor("/api/notes/batch-create").length, 1, "and must not re-push it");

  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("S4 a quit between the cloud ack and the local mark does not fork a duplicate", async (t) => {
  const cloud = freshCloud();
  const device = createDevice(t, cloud);
  if (!device) return;
  const { db } = device;

  const note = db.saveNote("Acked but unmarked", "body the cloud already has", "personal").note;
  setNoteRow(db, note.id, { created_at: T_SHELL, updated_at: T_SHELL });

  // The crash window: the cloud accepted the batch, then the process died before
  // markNoteSynced ran, so the row is still pending with no cloud_id.
  const pending = db.getPendingNotes();
  assert.equal(pending.length, 1);
  const acked = await cloud.request({
    method: "POST",
    path: "/api/notes/batch-create",
    body: {
      notes: [
        {
          client_note_id: pending[0].client_note_id,
          title: pending[0].title,
          content: pending[0].content,
          created_at: pending[0].created_at,
          updated_at: pending[0].updated_at,
        },
      ],
    },
  });
  const orphanCloudId = acked.data.created[0].id;
  assert.equal(db.getNote(note.id).cloud_id, null);

  const before = snapshotNotes(db);
  wipeCursors(device);
  await syncOnce(device);

  assert.equal(cloud.notes().length, 1, "the retry must re-use the stable client id, not fork");
  const row = db.getNote(note.id);
  assert.equal(
    row.cloud_id,
    orphanCloudId,
    "the local row must adopt the already-created cloud row"
  );
  assert.equal(row.sync_status, "synced");
  assert.equal(row.content, "body the cloud already has");
  assert.equal(noteCount(db), 1, "the pull must not insert a second local copy either");

  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("S4 a 500 mid-batch leaves error rows that the next pass retries on its own", async (t) => {
  const cloud = freshCloud();
  const device = createDevice(t, cloud);
  if (!device) return;
  const { db } = device;

  for (let i = 0; i < BATCH_SIZE + 3; i += 1) {
    const saved = db.saveNote(`Note ${i}`, `body ${i}`, "personal").note;
    setNoteRow(db, saved.id, { created_at: T_SHELL, updated_at: T_SHELL });
  }
  const doomed = db.getPendingNotes().slice(BATCH_SIZE);
  assert.equal(doomed.length, 3);

  // Only the trailing chunk is short, so this fires on the second request alone.
  cloud.failNext(
    (call) => call.path === "/api/notes/batch-create" && call.body?.notes?.length === 3,
    { status: 500, error: "chunk rejected" }
  );

  const before = snapshotNotes(db);
  await syncOnce(device);

  for (const note of doomed) {
    assert.equal(db.getNote(note.id).sync_status, "error");
  }
  assert.equal(cloud.notes().length, BATCH_SIZE, "only the healthy chunk landed");

  // Errored rows are pushable again on the very next pass: the retry needs no
  // re-edit, and its chunk carries exactly the rows that failed.
  await syncOnce(device);

  const batches = cloud.logFor("/api/notes/batch-create");
  assert.equal(batches.length, 3, "the next pass must retry the failed chunk");
  assert.equal(batches[2].body.notes.length, 3, "only the errored rows go out again");
  for (const note of doomed) {
    const row = db.getNote(note.id);
    assert.equal(row.sync_status, "synced", "a clean retry settles the row");
    assert.ok(row.cloud_id, "the retried row gains its cloud identity");
    assert.equal(row.content, note.content, "the local body survives the error round-trip");
  }
  assert.equal(cloud.notes().length, BATCH_SIZE + 3, "every note reaches the cloud in the end");

  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("S5 a snapshot pull of exactly BATCH_SIZE notes still asks for the page after it", async (t) => {
  const cloud = freshCloud();
  const device = createDevice(t, cloud);
  if (!device) return;
  const { db } = device;

  const base = Date.parse("2026-07-20T08:00:00.000Z");
  const seeded = [];
  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const at = new Date(base + i * 60000).toISOString();
    seeded.push(
      cloud.seedNote({
        client_note_id: `cn-${String(i).padStart(3, "0")}`,
        title: `Cloud note ${i}`,
        content: `cloud body ${i}`,
        created_at: at,
        updated_at: at,
      })
    );
  }

  const before = snapshotNotes(db);
  await syncOnce(device);

  const lists = cloud.logFor("/api/notes/list");
  assert.equal(
    lists.length,
    2,
    "a full last page is indistinguishable from a full middle one, so the pull must probe again"
  );
  assert.equal(queryParam(lists[0].path, "before"), null);
  assert.equal(
    queryParam(lists[1].path, "before"),
    seeded[0].created_at,
    "the probe must carry the oldest row of the full page as its cursor"
  );

  assert.equal(noteCount(db), BATCH_SIZE, "every seeded note must be applied exactly once");
  assert.equal(noteByClientId(db, "cn-000").content, "cloud body 0");
  assert.equal(noteByClientId(db, "cn-049").content, "cloud body 49");
  assert.ok(device.storage["lastSyncedAt.notes"], "a clean pull stamps the cursor");

  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("S5 a tombstone as the last row of a delta page still hands the next page a cursor", async (t) => {
  const cloud = freshCloud();
  const device = createDevice(t, cloud);
  if (!device) return;
  const { db } = device;

  const cursor = "2026-07-20T07:00:00.000Z";
  const base = Date.parse("2026-07-20T08:00:00.000Z");
  const seeded = [];
  for (let i = 0; i < BATCH_SIZE + 10; i += 1) {
    const at = new Date(base + i * 60000).toISOString();
    seeded.push(
      cloud.seedNote({
        client_note_id: `cn-${String(i).padStart(3, "0")}`,
        title: `Cloud note ${i}`,
        content: `cloud body ${i}`,
        created_at: at,
        updated_at: at,
      })
    );
  }

  const boundary = seeded[BATCH_SIZE - 1];
  const local = linkLocalNote(db, boundary, "Boundary note", "local boundary body");
  // Pinning the server clock to the row's own stamp keeps the tombstone in the
  // last slot of page one instead of sorting it to the end of the delta.
  cloud.setClock(() => boundary.updated_at);
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: boundary.id } });
  cloud.setClock(() => new Date().toISOString());

  device.storage["lastSyncedAt.notes"] = cursor;
  const before = snapshotNotes(db);
  await syncOnce(device);

  const lists = cloud.logFor("/api/notes/list");
  assert.equal(lists.length, 2, "60 delta rows at a page size of 50 must take two requests");
  assert.equal(queryParam(lists[0].path, "since"), cursor);
  assert.equal(
    queryParam(lists[1].path, "since"),
    boundary.updated_at,
    "a tombstone in the last slot must still supply the next cursor"
  );

  assert.equal(db.getNote(local.id), null, "the boundary tombstone must delete the local row");
  assert.equal(
    noteByClientId(db, "cn-059").content,
    "cloud body 59",
    "the page after the tombstone must still be applied"
  );
  assert.equal(noteCount(db), BATCH_SIZE + 9, "every row but the tombstoned one must be local");

  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

// A full delta page whose rows all carry the cursor's own updated_at trips the
// stall guard in pullNotes and silently skips everything past that page.
test.todo("S5 a full delta page tied on updated_at must not abandon the rest of the pull");

test("S6 a fresh device adopts the cloud's default folders and both note directions land in them", async (t) => {
  const cloud = freshCloud();
  const device = createDevice(t, cloud);
  if (!device) return;
  const { db } = device;

  const cloudPersonal = cloud.seedFolder({
    client_folder_id: "cf-personal",
    name: "Personal",
    is_default: true,
    sort_order: 0,
  });
  const cloudMeetings = cloud.seedFolder({
    client_folder_id: "cf-meetings",
    name: "Meetings",
    is_default: true,
    sort_order: 1,
  });
  cloud.seedNote({
    client_note_id: "cn-remote",
    title: "Meeting from the other device",
    content: "remote meeting body",
    folder_id: cloudMeetings.id,
    created_at: iso(T_SHELL),
    updated_at: iso(T_SHELL),
  });

  const localMeeting = db.saveNote(
    "Meeting from this device",
    "local meeting body",
    "meeting"
  ).note;
  setNoteRow(db, localMeeting.id, { created_at: T_SHELL, updated_at: T_SHELL });

  const before = snapshotNotes(db);
  await syncOnce(device);

  const meetings = folderByName(db, "Meetings");
  assert.equal(
    meetings.cloud_id,
    cloudMeetings.id,
    "the local default must adopt the cloud folder"
  );
  assert.equal(meetings.client_folder_id, "cf-meetings");
  assert.equal(folderByName(db, "Personal").cloud_id, cloudPersonal.id);
  assert.equal(
    cloud.folders().filter((f) => f.name === "Meetings").length,
    1,
    "adoption exists so a second device never forks a duplicate folder"
  );

  const [batch] = cloud.logFor("/api/notes/batch-create");
  assert.equal(
    batch.body.notes[0].folder_id,
    cloudMeetings.id,
    "the pushed note must carry the adopted cloud folder id, never the local integer"
  );
  assert.notEqual(batch.body.notes[0].folder_id, meetings.id);
  assert.equal(
    noteByClientId(db, "cn-remote").folder_id,
    meetings.id,
    "the pulled note must map back onto the same local folder"
  );
  assert.equal(noteByClientId(db, localMeeting.client_note_id).folder_id, meetings.id);

  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("S6 a note in a never-synced folder pushes without one and re-pushes once the folder is mapped", async (t) => {
  const cloud = freshCloud();
  const device = createDevice(t, cloud);
  if (!device) return;
  const { db } = device;
  silenceConsoleErrors(t);

  cloud.failWith("POST /api/folders/batch-create", { status: 500, error: "folder push down" });
  const folder = db.createFolder("Field Notes").folder;
  const note = db.saveNote("Interview", "interview body", "personal", null, null, folder.id).note;
  setNoteRow(db, note.id, { created_at: T_SHELL, updated_at: T_SHELL });

  const before = snapshotNotes(db);
  await syncOnce(device);

  const [batch] = cloud.logFor("/api/notes/batch-create");
  assert.equal(
    batch.body.notes[0].folder_id,
    null,
    "an unmapped folder must null the reference, never leak the local integer id"
  );
  const cloudId = db.getNote(note.id).cloud_id;
  assert.ok(cloudId, "the note must reach the cloud even with its folder stuck");
  assert.equal(cloud.note(cloudId).folder_id, null);
  assert.equal(db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id).cloud_id, null);

  // The folder push recovers, and the next edit is what carries the mapping up.
  cloud.clearFailures();
  db.updateNote(note.id, { content: "interview body, second draft" });
  setNoteRow(db, note.id, { updated_at: T_FUTURE });
  const mark = cloud.log.length;
  await syncOnce(device);

  const folderCloudId = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id).cloud_id;
  assert.ok(folderCloudId, "the retried folder push must land");

  const patches = cloud.log
    .slice(mark)
    .filter((c) => c.method === "PATCH" && c.path === "/api/notes/update");
  assert.equal(patches.length, 1);
  assert.equal(
    patches[0].body.folder_id,
    folderCloudId,
    "once the folder is mapped the note must be filed under it in the cloud"
  );
  assert.equal(patches[0].body.content, "interview body, second draft");
  assert.equal(cloud.note(cloudId).folder_id, folderCloudId);
  assert.equal(cloud.note(cloudId).content, "interview body, second draft");
  assert.equal(db.getNote(note.id).sync_status, "synced");

  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});
