// Orchestration coverage for the note half of SyncService: the real service
// drives the real cloudApi/NotesService layer over a real DatabaseManager, with
// only the HTTP boundary faked. Assertions land on what was *sent* whenever the
// behaviour under test is about the request, not just on the row that survived.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  acquireLock,
  localStorage: localStorageStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { assertNoContentRegression, snapshotNotes } = require("./harness/invariants.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { NotesService } = require("../../src/services/NotesService.ts");
const { CloudApiError } = require("../../src/services/cloudApi.ts");

// Mirrors SYNC_ALL_LOCK in SyncService.ts.
const SYNC_ALL_LOCK = "openwhispr-sync-all";
const BATCH_SIZE = 50;

// SQLite's datetime() format, the one local rows actually carry.
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

// Deterministic timestamps come from SQL, never from a fake clock.
function updateNote(db, id, fields) {
  const keys = Object.keys(fields);
  db.db
    .prepare(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return db.getNote(id);
}

function noteCount(db) {
  return db.db.prepare("SELECT COUNT(*) AS c FROM notes").get().c;
}

function queryParam(path, name) {
  const [, query] = path.split("?");
  return new URLSearchParams(query ?? "").get(name);
}

function silenceConsoleErrors(t) {
  return t.mock.method(console, "error", () => {});
}

function errorMessages(mock) {
  return mock.mock.calls.map((call) =>
    call.arguments.map((a) => String(a?.message ?? a)).join(" ")
  );
}

test("migration push sends the full note body, not just the client id", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  // The meeting shell exactly as meetingDetectionEngine.js creates it.
  const shell = db.saveNote("Weekly sync", "", "meeting").note;
  updateNote(db, shell.id, { created_at: LOCAL_EARLY, updated_at: LOCAL_EARLY });

  await service.syncAll(true);
  const cloudId = db.getNote(shell.id).cloud_id;
  assert.ok(cloudId, "first pass must give the shell a cloud id");
  assert.equal(cloud.note(cloudId).content, "", "the shell reaches the cloud empty");

  // Transcription lands afterwards and re-queues the row: this is the state the
  // migration branch has to upload.
  const filled = updateNote(db, shell.id, {
    content: "the transcribed meeting body",
    transcript: "raw diarized transcript",
    updated_at: LOCAL_LATE,
    sync_status: "pending",
  });

  const before = snapshotNotes(db);
  const mark = cloud.log.length;
  await service.syncAll(true);

  const patches = cloud.log
    .slice(mark)
    .filter((c) => c.method === "PATCH" && c.path === "/api/notes/update");
  assert.equal(patches.length, 1, "exactly one PATCH for the pending migration note");
  const body = patches[0].body;
  assert.equal(body.id, cloudId);
  assert.equal(body.client_note_id, filled.client_note_id);
  // A payload of { client_note_id } alone changes nothing server-side, so the
  // DB would still look fine; only the sent body exposes the regression.
  assert.equal(body.content, "the transcribed meeting body");
  assert.equal(body.transcript, "raw diarized transcript");
  assert.equal(body.title, "Weekly sync");
  assert.equal(body.updated_at, LOCAL_LATE);

  assert.equal(cloud.note(cloudId).content, "the transcribed meeting body");
  assert.equal(cloud.note(cloudId).transcript, "raw diarized transcript");
  assert.equal(db.getNote(shell.id).sync_status, "synced");
  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("migration push marks the note errored when the PATCH fails", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  const shell = db.saveNote("Weekly sync", "", "meeting").note;
  updateNote(db, shell.id, { created_at: LOCAL_EARLY, updated_at: LOCAL_EARLY });
  await service.syncAll(true);
  const cloudId = db.getNote(shell.id).cloud_id;

  updateNote(db, shell.id, {
    content: "the transcribed meeting body",
    updated_at: LOCAL_LATE,
    sync_status: "pending",
  });

  cloud.failNext("PATCH /api/notes/update", { status: 500, error: "boom" });
  const before = snapshotNotes(db);
  await service.syncAll(true);

  const row = db.getNote(shell.id);
  assert.equal(row.sync_status, "error", "a failed push must leave the row retryable, not synced");
  assert.equal(row.cloud_id, cloudId, "the cloud id is not dropped by a failed push");
  assert.equal(row.content, "the transcribed meeting body", "the local body survives the failure");
  assert.equal(cloud.note(cloudId).content, "", "nothing reached the cloud");
  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("fresh notes are pushed in BATCH_SIZE chunks with acks matched by client id", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  for (let i = 0; i < BATCH_SIZE + 1; i += 1) {
    db.saveNote(`Note ${i}`, `body ${i}`, "personal");
  }

  // The cloud is free to answer in any order; matching acks positionally would
  // hand every note its neighbour's cloud id.
  const inner = windowStub.electronAPI.cloudApiRequest;
  windowStub.electronAPI.cloudApiRequest = async (opts) => {
    const result = await inner(opts);
    if (opts.path === "/api/notes/batch-create" && result.success) {
      return { ...result, data: { created: [...result.data.created].reverse() } };
    }
    return result;
  };

  await service.syncAll(true);

  const batches = cloud.logFor("/api/notes/batch-create");
  assert.equal(batches.length, 2, "51 fresh notes must go out as two chunks");
  assert.equal(batches[0].body.notes.length, BATCH_SIZE);
  assert.equal(batches[1].body.notes.length, 1);

  const rows = db.db.prepare("SELECT * FROM notes ORDER BY id").all();
  assert.equal(rows.length, BATCH_SIZE + 1);
  for (const row of rows) {
    assert.equal(row.sync_status, "synced");
    assert.equal(
      row.cloud_id,
      cloud.note(row.client_note_id).id,
      `note ${row.id} was acked with another note's cloud id`
    );
  }
});

test("a failing chunk marks only its own members as errored", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  for (let i = 0; i < BATCH_SIZE + 1; i += 1) {
    db.saveNote(`Note ${i}`, `body ${i}`, "personal");
  }
  const pending = db.getPendingNotes();
  const firstChunk = pending.slice(0, BATCH_SIZE);
  const secondChunk = pending.slice(BATCH_SIZE);

  // Only the second chunk carries a single note, so this fires on it alone.
  cloud.failNext(
    (call) => call.path === "/api/notes/batch-create" && call.body?.notes?.length === 1,
    { status: 500, error: "chunk rejected" }
  );

  await service.syncAll(true);

  for (const note of firstChunk) {
    const row = db.getNote(note.id);
    assert.equal(row.sync_status, "synced", `note ${note.id} of the healthy chunk must be synced`);
    assert.ok(row.cloud_id);
  }
  for (const note of secondChunk) {
    const row = db.getNote(note.id);
    assert.equal(row.sync_status, "error", `note ${note.id} of the failed chunk must be errored`);
    assert.equal(row.cloud_id, null);
  }
  assert.equal(cloud.notes().length, BATCH_SIZE, "only the healthy chunk reached the cloud");
});

test("pullNotes applies a strictly newer cloud copy and rejects older and tied ones", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  // All three cloud copies sit on the same UTC day as the local rows, where a
  // raw string compare wrongly elects the cloud value ('T' > ' ' at index 10).
  const cases = [
    { key: "older", cloudUpdatedAt: "2026-07-20T09:00:00.000Z", applied: false },
    { key: "newer", cloudUpdatedAt: "2026-07-20T11:00:00.000Z", applied: true },
    { key: "tied", cloudUpdatedAt: "2026-07-20T10:00:00.000Z", applied: false },
  ];

  for (const c of cases) {
    const cloudRow = cloud.seedNote({
      client_note_id: `client-${c.key}`,
      title: `Cloud ${c.key}`,
      content: `cloud body ${c.key}`,
      created_at: "2026-07-20T08:00:00.000Z",
      updated_at: c.cloudUpdatedAt,
    });
    const local = db.saveNote(`Local ${c.key}`, `local body ${c.key}`, "personal").note;
    updateNote(db, local.id, {
      client_note_id: cloudRow.client_note_id,
      cloud_id: cloudRow.id,
      sync_status: "synced",
      created_at: LOCAL_EARLY,
      updated_at: LOCAL_EARLY,
    });
    c.localId = local.id;
  }

  const before = snapshotNotes(db);
  await service.syncAll(true);

  for (const c of cases) {
    const row = db.getNote(c.localId);
    if (c.applied) {
      assert.equal(row.content, `cloud body ${c.key}`, "a strictly newer cloud copy must win");
      assert.equal(row.title, `Cloud ${c.key}`);
    } else {
      assert.equal(
        row.content,
        `local body ${c.key}`,
        `the ${c.key} cloud copy must not overwrite the local row`
      );
      assert.equal(row.title, `Local ${c.key}`);
      assert.equal(row.updated_at, LOCAL_EARLY, "a rejected pull must not move updated_at");
    }
  }
  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});

test("a cloud tombstone hard-deletes the local note", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const cloudRow = cloud.seedNote({
    client_note_id: "client-tombstoned",
    title: "Deleted elsewhere",
    content: "gone",
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: "2026-07-20T08:00:00.000Z",
  });
  const local = db.saveNote("Deleted elsewhere", "gone", "personal").note;
  updateNote(db, local.id, {
    client_note_id: cloudRow.client_note_id,
    cloud_id: cloudRow.id,
    sync_status: "synced",
    created_at: LOCAL_EARLY,
    updated_at: LOCAL_EARLY,
  });

  // Tombstones only travel on the delta page, so the cursor must already exist.
  localStorageStub.setItem("lastSyncedAt.notes", "2026-07-01T00:00:00.000Z");
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: cloudRow.id } });
  const mark = cloud.log.length;

  await service.syncAll(true);

  const listCalls = cloud.log.slice(mark).filter((c) => c.path.split("?")[0] === "/api/notes/list");
  assert.ok(listCalls.length > 0);
  assert.equal(
    queryParam(listCalls[0].path, "since"),
    "2026-07-01T00:00:00.000Z",
    "the delta page must be requested with the stored cursor"
  );
  assert.equal(db.getNoteByClientId("client-tombstoned"), null, "the local row must be removed");
  assert.equal(noteCount(db), 0);
});

test("a pending local delete issues the DELETE and then hard-deletes locally", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const cloudRow = cloud.seedNote({
    client_note_id: "client-locally-deleted",
    title: "Removed here",
    content: "body",
    created_at: "2026-07-19T09:00:00.000Z",
    updated_at: "2026-07-19T09:00:00.000Z",
  });
  const local = db.saveNote("Removed here", "body", "personal").note;
  updateNote(db, local.id, {
    client_note_id: cloudRow.client_note_id,
    cloud_id: cloudRow.id,
    sync_status: "pending",
    deleted_at: LOCAL_LATE,
    created_at: LOCAL_EARLY,
    updated_at: LOCAL_EARLY,
  });

  await service.syncAll(true);

  const deletes = cloud.logFor("/api/notes/delete");
  assert.equal(deletes.length, 1, "the tombstone must reach the cloud exactly once");
  assert.equal(deletes[0].method, "DELETE");
  assert.deepEqual(deletes[0].body, { id: cloudRow.id });
  assert.equal(db.getNote(local.id), null, "the local row is only removed after the cloud ack");
  assert.ok(cloud.note(cloudRow.id).deleted_at, "the cloud row is tombstoned");
});

test("a 500 on the delete leaves the tombstone pending and the local row intact", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  const cloudRow = cloud.seedNote({
    client_note_id: "client-delete-failed",
    title: "Removed here",
    content: "body",
    created_at: "2026-07-19T09:00:00.000Z",
    updated_at: "2026-07-19T09:00:00.000Z",
  });
  const local = db.saveNote("Removed here", "body", "personal").note;
  updateNote(db, local.id, {
    client_note_id: cloudRow.client_note_id,
    cloud_id: cloudRow.id,
    sync_status: "pending",
    deleted_at: LOCAL_LATE,
    created_at: LOCAL_EARLY,
    updated_at: LOCAL_EARLY,
  });

  cloud.failNext("DELETE /api/notes/delete", { status: 500, error: "delete failed" });
  await service.syncAll(true);

  const row = db.getNote(local.id);
  assert.ok(row, "a failed delete must not remove the row locally");
  assert.equal(row.deleted_at, LOCAL_LATE);
  assert.equal(row.sync_status, "pending", "the tombstone stays queued for the next pass");
  assert.equal(db.getPendingNoteDeletes().length, 1);
  assert.equal(cloud.note(cloudRow.id).deleted_at, null, "the cloud row is untouched");
});

test("the pull pages 120 cloud notes with a correct cursor and stamps the cursor once", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const base = Date.parse("2026-07-20T08:00:00.000Z");
  const seeded = [];
  for (let i = 0; i < 120; i += 1) {
    const at = new Date(base + i * 60000).toISOString();
    seeded.push(
      cloud.seedNote({
        client_note_id: `client-${String(i).padStart(3, "0")}`,
        title: `Cloud note ${i}`,
        content: `cloud body ${i}`,
        created_at: at,
        updated_at: at,
      })
    );
  }

  await service.syncAll(true);

  const listCalls = cloud.logFor("/api/notes/list");
  assert.equal(listCalls.length, 3, "120 notes at a page size of 50 must take three requests");
  assert.equal(queryParam(listCalls[0].path, "limit"), String(BATCH_SIZE));
  assert.equal(queryParam(listCalls[0].path, "before"), null, "the first page carries no cursor");
  // Pages walk created_at backwards, so each cursor is the oldest row of the
  // page before it.
  assert.equal(queryParam(listCalls[1].path, "before"), seeded[70].created_at);
  assert.equal(queryParam(listCalls[2].path, "before"), seeded[20].created_at);

  assert.equal(noteCount(db), 120, "every page must be applied exactly once");
  assert.equal(db.getNoteByClientId("client-000").content, "cloud body 0");
  assert.equal(db.getNoteByClientId("client-119").content, "cloud body 119");
  assert.ok(
    Date.parse(localStorageStub.getItem("lastSyncedAt.notes")) > 0,
    "a clean pull stamps the cursor"
  );
});

test("a mid-pagination failure leaves the pull cursor unstamped", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  const base = Date.parse("2026-07-20T08:00:00.000Z");
  for (let i = 0; i < 120; i += 1) {
    const at = new Date(base + i * 60000).toISOString();
    cloud.seedNote({
      client_note_id: `client-${String(i).padStart(3, "0")}`,
      title: `Cloud note ${i}`,
      content: `cloud body ${i}`,
      created_at: at,
      updated_at: at,
    });
  }

  // Only pages after the first carry a cursor.
  cloud.failNext(
    (call) => call.path.startsWith("/api/notes/list") && call.path.includes("before="),
    { status: 500, error: "page 2 exploded" }
  );

  await service.syncAll(true);

  assert.equal(cloud.logFor("/api/notes/list").length, 2, "paging stops at the failure");
  assert.equal(noteCount(db), 50, "the first page is still applied");
  assert.equal(
    localStorageStub.getItem("lastSyncedAt.notes"),
    null,
    "a partial pull must not advance the cursor, or the missing pages are lost forever"
  );
});

test("canSync gating: sign-out blocks every call; plan and backup gates protect personal notes", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const note = db.saveNote("Pending note", "body", "personal").note;

  enableSync();
  localStorageStub.removeItem("isSignedIn");
  const signedOutService = new SyncService();
  await signedOutService.syncAll(true);
  stopSyncTimers(signedOutService);
  assert.equal(cloud.log.length, 0, "sync ran while signed out");
  assert.equal(localStorageStub.getItem("lastSyncedAt"), null);

  // Collaboration is free, so an unsubscribed account still checks shared
  // notes and team spaces. Private backup remains paid and must not run.
  enableSync();
  localStorageStub.removeItem("isSubscribed");
  const freeService = new SyncService();
  await freeService.syncAll(true);
  stopSyncTimers(freeService);
  assert.ok(cloud.log.length > 0, "a free signed-in account must still sync collaboration");
  assert.equal(cloud.logFor("/api/notes/batch-create").length, 0);
  assert.equal(db.getNote(note.id).sync_status, "pending");

  // Backup off is not sign-out: team-space membership still syncs, but nothing
  // personal may leave the machine.
  enableSync();
  localStorageStub.removeItem("cloudBackupEnabled");
  const markBeforeBackupOff = cloud.log.length;
  const teamOnlyService = new SyncService();
  await teamOnlyService.syncAll(true);
  stopSyncTimers(teamOnlyService);
  assert.equal(
    cloud.log.slice(markBeforeBackupOff).filter((call) => call.path === "/api/notes/batch-create")
      .length,
    0,
    "a personal note must not push while backup is off"
  );
  assert.equal(db.getNote(note.id).sync_status, "pending");

  enableSync();
  const mark = cloud.log.length;
  const fullService = new SyncService();
  await fullService.syncAll(true);
  stopSyncTimers(fullService);
  assert.ok(cloud.log.length > mark, "with all three keys set the same pass must do real work");
  assert.equal(
    db.getNote(note.id).sync_status,
    "synced",
    "the personal note pushes once backup is back on"
  );
});

test("an ambient pass bows out when another window holds the lock, a manual pass waits", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  db.saveNote("Pending note", "body", "personal");

  const release = await acquireLock(SYNC_ALL_LOCK);

  // Racing a timer, because an ambient pass that queues instead of bowing out
  // never returns at all while the holder keeps the lock.
  const ambient = service.syncAll(false);
  const outcome = await Promise.race([
    ambient.then(() => "returned"),
    new Promise((resolve) => setTimeout(() => resolve("queued"), 50)),
  ]);
  assert.equal(outcome, "returned", "an ambient pass must bow out, not queue behind the holder");
  assert.equal(cloud.log.length, 0, "an ambient pass must skip while the lock is held");
  assert.equal(localStorageStub.getItem("lastSyncedAt"), null);

  // A manual pass queues instead of skipping.
  const manual = service.syncAll(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cloud.log.length, 0, "the manual pass must wait, not run alongside the holder");

  release();
  await manual;
  assert.ok(cloud.log.length > 0, "the manual pass runs once the lock frees");
  assert.ok(localStorageStub.getItem("lastSyncedAt"));
});

test("a request arriving mid-pass re-runs syncAll exactly once", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, service } = ctx;

  const first = service.syncAll(true);
  // syncing is already true here, so this request must be deferred, not dropped.
  await service.syncAll();
  await first;

  assert.equal(
    cloud.logFor("/api/notes/list").length,
    2,
    "the deferred request must trigger exactly one extra pass"
  );
});

test("a note pull failure is contained: the pass finishes and later stages still run", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const errors = silenceConsoleErrors(t);
  const note = db.saveNote("Pending note", "body", "personal").note;

  cloud.failWith("/api/notes/list", { status: 500, error: "list exploded" });
  await service.syncAll(true);

  assert.equal(db.getNote(note.id).sync_status, "synced", "the push before the pull still lands");
  assert.equal(cloud.logFor("/api/transcriptions/list").length, 1, "later stages still run");
  assert.equal(cloud.logFor("/api/snippets/list").length, 1);
  assert.equal(
    localStorageStub.getItem("lastSyncedAt.notes"),
    null,
    "a failed pull must not advance the note cursor"
  );
  assert.ok(localStorageStub.getItem("lastSyncedAt"), "the pass as a whole still completes");
  assert.ok(errorMessages(errors).some((m) => m.includes("Note pull failed")));
});

test("a missing dictionary IPC binding aborts the pass without stamping lastSyncedAt", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const errors = silenceConsoleErrors(t);
  const note = db.saveNote("Pending note", "body", "personal").note;

  delete windowStub.electronAPI.markDictionarySynced;
  await service.syncAll(true);

  assert.equal(db.getNote(note.id).sync_status, "synced", "stages before the abort still ran");
  assert.equal(cloud.logFor("/api/snippets/list").length, 0, "the pass stops at the bad binding");
  assert.equal(
    localStorageStub.getItem("lastSyncedAt"),
    null,
    "an aborted pass must not claim to have completed"
  );
  assert.ok(
    errorMessages(errors).some((m) => m.includes("markDictionarySynced")),
    "the missing binding must be named in the failure"
  );
});

test("an AUTH_EXPIRED envelope surfaces as a 401 CloudApiError and nothing is marked synced", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  const cloudRow = cloud.seedNote({
    client_note_id: "client-queued-delete",
    title: "Removed here",
    content: "body",
    created_at: "2026-07-19T09:00:00.000Z",
    updated_at: "2026-07-19T09:00:00.000Z",
  });
  const fresh = db.saveNote("Fresh note", "fresh body", "personal").note;
  updateNote(db, fresh.id, { created_at: LOCAL_EARLY, updated_at: LOCAL_EARLY });
  const queuedDelete = db.saveNote("Removed here", "body", "personal").note;
  updateNote(db, queuedDelete.id, {
    client_note_id: cloudRow.client_note_id,
    cloud_id: cloudRow.id,
    sync_status: "pending",
    deleted_at: LOCAL_LATE,
    created_at: LOCAL_EARLY,
    updated_at: LOCAL_EARLY,
  });

  cloud.failWith(() => true, {
    status: 401,
    code: "AUTH_EXPIRED",
    error: "Session expired",
  });

  await assert.rejects(
    () => NotesService.list(BATCH_SIZE),
    (err) => {
      assert.ok(err instanceof CloudApiError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "AUTH_EXPIRED");
      assert.equal(err.message, "Session expired");
      return true;
    }
  );

  const before = snapshotNotes(db);
  await service.syncAll(true);

  const freshRow = db.getNote(fresh.id);
  assert.equal(freshRow.cloud_id, null, "an expired session must not hand out a cloud id");
  assert.notEqual(freshRow.sync_status, "synced");
  assert.equal(freshRow.content, "fresh body");

  const deleteRow = db.getNote(queuedDelete.id);
  assert.ok(deleteRow, "the queued delete must survive an expired session");
  assert.equal(deleteRow.sync_status, "pending");
  assert.equal(cloud.notes().length, 1, "nothing new reached the cloud");
  assert.equal(cloud.note(cloudRow.id).deleted_at, null);
  assertNoContentRegression(before, snapshotNotes(db), cloud.notes());
});
