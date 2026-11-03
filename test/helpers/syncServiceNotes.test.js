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
const { addNoteConflict, readNoteConflictIds } = require("../../src/lib/noteConflictRegistry.ts");

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

test("an untitled cloud note is saved as Untitled Note and does not stall the pull", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const errors = silenceConsoleErrors(t);

  const cursor = "2026-07-01T00:00:00.000Z";
  localStorageStub.setItem("lastSyncedAt.notes", cursor);
  // Notes created through the public API without a title arrive with none.
  cloud.seedNote({
    client_note_id: "client-untitled",
    content: "Recap saved from Claude",
    created_at: "2026-07-20T09:00:00.000Z",
    updated_at: "2026-07-20T09:00:00.000Z",
  });
  // An edit made on another device afterwards sits behind it in the delta feed.
  cloud.seedNote({
    client_note_id: "client-later",
    title: "Edited on another device",
    content: "later body",
    created_at: "2026-07-20T10:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
  });

  await service.syncAll(true);

  const untitled = db.getNoteByClientId("client-untitled");
  assert.equal(untitled?.title, "Untitled Note", "a missing cloud title takes the local default");
  assert.equal(untitled?.content, "Recap saved from Claude");
  assert.equal(db.getNoteByClientId("client-later")?.content, "later body");
  assert.notEqual(localStorageStub.getItem("lastSyncedAt.notes"), cursor, "the cursor advances");
  assert.ok(!errorMessages(errors).some((m) => m.includes("Note pull failed")));
});

test("a cloud note that fails to save is retried without blocking the rest of the pull", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const errors = silenceConsoleErrors(t);

  const cursor = "2026-07-01T00:00:00.000Z";
  localStorageStub.setItem("lastSyncedAt.notes", cursor);
  const failing = cloud.seedNote({
    client_note_id: "client-failing",
    title: "Fails once",
    content: "retry me",
    created_at: "2026-07-20T09:00:00.000Z",
    updated_at: "2026-07-20T09:00:00.000Z",
  });
  cloud.seedNote({
    client_note_id: "client-after",
    title: "Behind it",
    content: "still arrives",
    created_at: "2026-07-20T10:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
  });
  const upsert = api.upsertNoteFromCloud;
  let failuresLeft = 1;
  t.mock.method(api, "upsertNoteFromCloud", async (cloudNote, ...rest) => {
    if (cloudNote.id === failing.id && failuresLeft-- > 0) throw new Error("disk I/O error");
    return upsert(cloudNote, ...rest);
  });

  await service.syncAll(true);

  assert.equal(db.getNoteByClientId("client-after")?.content, "still arrives");
  assert.equal(db.getNoteByClientId("client-failing"), null);
  assert.equal(
    localStorageStub.getItem("lastSyncedAt.notes"),
    cursor,
    "the cursor holds so the next pass retries the failed note"
  );
  assert.ok(
    errorMessages(errors).some((m) => m.includes(`Note pull failed for cloud note ${failing.id}`))
  );

  await service.syncAll(true);

  assert.equal(db.getNoteByClientId("client-failing")?.content, "retry me");
  assert.notEqual(localStorageStub.getItem("lastSyncedAt.notes"), cursor);
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

test("retention opt-out still drains analytics deletes without uploading counters", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { api, service } = ctx;
  localStorageStub.setItem("insightsSyncEnabled", "true");
  localStorageStub.setItem("dataRetentionEnabled", "false");

  let deleteReads = 0;
  let localDeletes = 0;
  let uploadReads = 0;
  api.getPendingAnalyticsDeletes = async () =>
    deleteReads++ === 0 ? [{ event_id: "deleted-event" }] : [];
  api.hardDeleteAnalyticsEvents = async (eventIds) => {
    localDeletes += eventIds.length;
    return { success: true, deleted: eventIds.length };
  };
  api.getPendingAnalyticsEvents = async () => {
    uploadReads += 1;
    return [];
  };
  api.markAnalyticsEventsSynced = async () => ({ success: true, updated: 0 });
  const request = api.cloudApiRequest;
  api.cloudApiRequest = async (options) => {
    if (options.path === "/api/analytics/events/delete") {
      return { success: true, data: { deleted: options.body.eventIds } };
    }
    return request(options);
  };

  await service.syncAll(true);

  assert.equal(localDeletes, 1, "the acknowledged privacy tombstone is retired locally");
  assert.equal(uploadReads, 0, "retention opt-out must not inspect or send pending counters");
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

  // Model an older API's incomplete receipt; the normal fake now returns
  // authoritative text, which can settle without waiting for a list request.
  const retries = [];
  t.mock.method(service, "requestSyncAll", (reason) => retries.push(reason));
  const request = windowStub.electronAPI.cloudApiRequest;
  t.mock.method(windowStub.electronAPI, "cloudApiRequest", async (options) => {
    const result = await request(options);
    if (options.path === "/api/notes/batch-create" && result.success) {
      result.data.created = result.data.created.map(({ id, client_note_id, updated_at }) => ({
        id,
        client_note_id,
        updated_at,
      }));
    }
    return result;
  });
  cloud.failWith("/api/notes/list", { status: 500, error: "list exploded" });
  await service.syncAll(true);

  assert.equal(cloud.note(note.client_note_id).content, "body", "the push before the pull lands");
  assert.equal(
    db.getNote(note.id).sync_status,
    "pending",
    "an incomplete receipt still needs an authoritative row before settling"
  );
  assert.equal(cloud.logFor("/api/transcriptions/list").length, 1, "later stages still run");
  assert.equal(cloud.logFor("/api/snippets/list").length, 1);
  assert.ok(retries.includes("retry"), "the incomplete create asks for a recovery pass");
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

test("an unlinked calendar event reaches the cloud as a blank and clears a stale copy on pull", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const note = db.saveNote("Weekly sync", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "evt-1" });
  await service.syncAll(true);
  const cloudId = db.getNote(note.id).cloud_id;
  assert.equal(cloud.note(cloudId).calendar_event_id, "evt-1");

  db.updateNote(note.id, { calendar_event_id: "" });
  await service.syncAll(true);
  assert.equal(cloud.note(cloudId).calendar_event_id, "");

  // Model a second device that still holds the link, then a newer edit from
  // elsewhere that does not mention the event.
  updateNote(db, note.id, {
    calendar_event_id: "evt-1",
    sync_status: "synced",
    updated_at: LOCAL_EARLY,
  });
  await cloud.request({
    method: "PATCH",
    path: "/api/notes/update",
    body: { id: cloudId, title: "Renamed elsewhere" },
  });
  await service.syncAll(true);

  const local = db.getNote(note.id);
  assert.equal(local.title, "Renamed elsewhere");
  assert.equal(local.calendar_event_id, "");
});

// A local row as older releases left them: another key for the same cloud row.
function insertCloudCopy(db, fields) {
  const row = {
    title: "Copy",
    content: "body",
    space_id: db.getPrivateSpaceId(),
    sync_status: "synced",
    cloud_updated_at: "2026-07-20T09:00:00.000Z",
    updated_at: LOCAL_EARLY,
    ...fields,
  };
  const keys = Object.keys(row);
  return db.db
    .prepare(`INSERT INTO notes (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...keys.map((key) => row[key])).lastInsertRowid;
}

function copiesOf(db, cloudId) {
  return db.db.prepare("SELECT * FROM notes WHERE cloud_id = ? ORDER BY id").all(cloudId);
}

async function editInCloud(cloud, id, fields) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cloud.request({
    method: "PATCH",
    path: "/api/notes/update",
    body: { id, ...fields },
  });
}

test("a cloud note with no client id keeps one local copy through edits and a delete", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedUnkeyedNote({ title: "Unkeyed", content: "first" });
  await service.syncAll(true);
  const [copy] = copiesOf(db, row.id);
  assert.ok(copy.client_note_id, "the copy gets a local key");

  await editInCloud(cloud, row.id, { content: "second" });
  await service.syncAll(true);
  assert.deepEqual(
    copiesOf(db, row.id).map((note) => [note.id, note.client_note_id, note.content]),
    [[copy.id, copy.client_note_id, "second"]]
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
  await service.syncAll(true);
  assert.equal(noteCount(db), 0, "the cloud delete reaches the copy");
});

test("a local copy adopts the client id its cloud row gains, without a second copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedUnkeyedNote({ title: "Unkeyed", content: "first" });
  await service.syncAll(true);
  const [copy] = copiesOf(db, row.id);

  cloud.backfillNoteKey(row.id);
  await editInCloud(cloud, row.id, { content: "after the backfill" });
  await service.syncAll(true);

  assert.deepEqual(
    copiesOf(db, row.id).map((note) => [note.id, note.client_note_id, note.content]),
    [[copy.id, row.id, "after the backfill"]]
  );
  assert.equal(noteCount(db), 1);
});

test("Refresh on a conflicted copy settles it even when the cloud row has another key", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedUnkeyedNote({ title: "Unkeyed", content: "cloud" });
  await service.syncAll(true);
  const [copy] = copiesOf(db, row.id);
  cloud.backfillNoteKey(row.id);
  await editInCloud(cloud, row.id, { content: "cloud edit" });
  updateNote(db, copy.id, { content: "stale edit", sync_status: "pending" });
  await service.syncAll(true);

  // What NoteEditor's Refresh sends: the cloud copy held by the conflict.
  const [fresh] = (await cloud.request({ method: "GET", path: "/api/notes/list" })).data.notes;
  const refreshed = db.upsertNoteFromCloud(fresh, copy.folder_id, copy.space_id);
  assert.equal(refreshed.id, copy.id);
  assert.equal(refreshed.sync_status, "synced");
  assert.equal(refreshed.content, "cloud edit");

  const patchesBefore = cloud.logFor("/api/notes/update").length;
  await service.syncAll(true);
  assert.equal(cloud.logFor("/api/notes/update").length, patchesBefore, "nothing left to push");
  assert.equal(noteCount(db), 1);
});

test("a synced copy with no revision stops forcing a snapshot pull once it is matched", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "body" });
  cloud.setNoteRevision(row.id, 3);
  insertCloudCopy(db, { client_note_id: "local-key", cloud_id: row.id });
  await service.syncAll(true);

  assert.equal(db.countNotesMissingRevision(), 0);
  assert.equal(copiesOf(db, row.id)[0].client_note_id, "cloud-key");
  assert.equal(noteCount(db), 1);
});

test("merging keeps the newest clean copy and moves chats and speakers onto it", (t) => {
  const db = createDb(t);
  if (!db) return;
  const older = insertCloudCopy(db, {
    client_note_id: "older",
    cloud_id: "cloud-1",
    content: "old",
    cloud_revision: 2,
  });
  const newest = insertCloudCopy(db, {
    client_note_id: "cloud-1",
    cloud_id: "cloud-1",
    content: "new",
    cloud_revision: 5,
  });
  const chat = db.createAgentConversation("Chat", older);
  db.db
    .prepare("INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, ?, ?)")
    .run(older, "speaker-1", "Ada");
  db.db
    .prepare("INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, ?, ?)")
    .run(newest, "speaker-1", "Kept");
  db.db
    .prepare("INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, ?, ?)")
    .run(older, "speaker-2", "Moved");
  db.db
    .prepare(
      "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
    )
    .run(older, "speaker-2", Buffer.from([1]));

  db.initDatabase();

  assert.deepEqual(
    copiesOf(db, "cloud-1").map((note) => note.id),
    [newest]
  );
  assert.equal(
    db.db.prepare("SELECT note_id FROM agent_conversations WHERE id = ?").get(chat.id).note_id,
    newest
  );
  assert.deepEqual(
    db.db
      .prepare("SELECT note_id, speaker_id, display_name FROM speaker_mappings ORDER BY speaker_id")
      .all(),
    [
      { note_id: newest, speaker_id: "speaker-1", display_name: "Kept" },
      { note_id: newest, speaker_id: "speaker-2", display_name: "Moved" },
    ]
  );
  assert.deepEqual(db.db.prepare("SELECT note_id FROM note_speaker_embeddings").all(), [
    { note_id: newest },
  ]);

  db.mergeDuplicateCloudNotes();
  assert.equal(noteCount(db), 1, "merging again changes nothing");
});

test("merging keeps the copy nearest the cloud and gives other unpushed text its own note", (t) => {
  const db = createDb(t);
  if (!db) return;
  const current = insertCloudCopy(db, {
    client_note_id: "current",
    cloud_id: "cloud-1",
    content: "newest in cloud",
    cloud_revision: 9,
  });
  const dirty = insertCloudCopy(db, {
    client_note_id: "dirty",
    cloud_id: "cloud-1",
    content: "unpushed",
    sync_status: "pending",
    cloud_revision: 3,
  });
  const sameText = insertCloudCopy(db, {
    client_note_id: "same-text",
    cloud_id: "cloud-1",
    content: "unpushed",
    sync_status: "pending",
    cloud_revision: 2,
  });
  const otherText = insertCloudCopy(db, {
    client_note_id: "other-text",
    cloud_id: "cloud-1",
    content: "different unpushed",
    sync_status: "error",
    cloud_revision: 1,
    is_shared: 1,
    share_token: "token",
  });

  db.mergeDuplicateCloudNotes();

  assert.deepEqual(
    copiesOf(db, "cloud-1").map((note) => [note.id, note.content, note.cloud_revision]),
    [[current, "newest in cloud", 9]]
  );
  assert.equal(db.getNote(current).share_token, "token", "the share stays with the cloud note");
  assert.equal(db.getNote(sameText), null, "two copies of one edit make one note");
  for (const id of [dirty, otherText]) {
    const detached = db.getNote(id);
    assert.equal(detached.cloud_id, null);
    assert.equal(detached.sync_status, "pending");
    assert.equal(detached.is_shared, 0);
    assert.equal(detached.cloud_revision, null);
  }
  assert.equal(db.getNote(otherText).content, "different unpushed");
  assert.notEqual(db.getNote(otherText).client_note_id, "other-text");
});

test("merging keeps an unpushed edit made on the current cloud revision", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCloudCopy(db, { client_note_id: "clean", cloud_id: "cloud-1", cloud_revision: 5 });
  const edited = insertCloudCopy(db, {
    client_note_id: "edited",
    cloud_id: "cloud-1",
    content: "edited on current",
    sync_status: "pending",
    cloud_revision: 5,
  });

  db.mergeDuplicateCloudNotes();

  assert.deepEqual(
    copiesOf(db, "cloud-1").map((note) => [note.id, note.sync_status]),
    [[edited, "pending"]]
  );
  assert.equal(noteCount(db), 1);
});

test("a queued delete of one copy no longer deletes the note everywhere", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "body" });
  await service.syncAll(true);
  insertCloudCopy(db, {
    client_note_id: "stale-copy",
    cloud_id: row.id,
    sync_status: "pending",
    deleted_at: LOCAL_LATE,
  });

  db.mergeDuplicateCloudNotes();
  await service.syncAll(true);

  assert.equal(cloud.logFor("/api/notes/delete").length, 0);
  assert.deepEqual(
    copiesOf(db, row.id).map((note) => [note.client_note_id, note.deleted_at]),
    [["cloud-key", null]]
  );
});

test("when every copy is deleted, merging leaves one delete to push", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "body" });
  for (const key of ["first", "second"]) {
    insertCloudCopy(db, {
      client_note_id: key,
      cloud_id: row.id,
      sync_status: "pending",
      deleted_at: LOCAL_LATE,
    });
  }

  db.mergeDuplicateCloudNotes();
  assert.equal(copiesOf(db, row.id).length, 1);

  await service.syncAll(true);
  assert.equal(cloud.logFor("/api/notes/delete").length, 1);
  assert.equal(noteCount(db), 0);
});

test("merging leaves copies alone while another owner or flow still holds them", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCloudCopy(db, { client_note_id: "account-a", cloud_id: "cloud-a", account_id: "a" });
  insertCloudCopy(db, { client_note_id: "account-b", cloud_id: "cloud-a", account_id: "b" });
  insertCloudCopy(db, { client_note_id: "plain", cloud_id: "cloud-b" });
  insertCloudCopy(db, {
    client_note_id: "create-pending",
    cloud_id: "cloud-b",
    cloud_create_pending: "{}",
  });
  insertCloudCopy(db, { client_note_id: "plain-2", cloud_id: "cloud-c" });
  const journaled = insertCloudCopy(db, { client_note_id: "journaled", cloud_id: "cloud-c" });
  db.db
    .prepare(
      `INSERT INTO optimistic_folder_delete_rows
         (folder_id, entity_type, entity_id, original_sync_status)
       VALUES (1, 'note', ?, 'synced')`
    )
    .run(journaled);

  db.mergeDuplicateCloudNotes();

  assert.equal(copiesOf(db, "cloud-a").length, 2, "another account's row is not ours");
  assert.equal(copiesOf(db, "cloud-b").length, 2, "an unresolved create keeps its row");
  assert.equal(copiesOf(db, "cloud-c").length, 2, "a pending folder delete owns its row");
});

test("a kept copy that is blank neither loses the other copy's text nor takes it in", (t) => {
  const db = createDb(t);
  if (!db) return;
  const fuller = insertCloudCopy(db, {
    client_note_id: "fuller",
    cloud_id: "cloud-1",
    content: "only copy of the body",
    enhanced_content: "summary",
    transcript: "transcript",
    is_shared: 1,
    share_token: "token",
    cloud_revision: 3,
  });
  const blank = insertCloudCopy(db, {
    client_note_id: "blank",
    cloud_id: "cloud-1",
    content: "",
    cloud_revision: 4,
  });

  db.mergeDuplicateCloudNotes();

  // The blank may be a deliberate clear: filling it would republish cleared text
  // under a current base. Its own note can't overwrite anything.
  const kept = db.getNote(blank);
  assert.equal(kept.content, "");
  assert.equal(kept.enhanced_content, null);
  assert.equal(kept.cloud_revision, 4);
  assert.equal(kept.sync_status, "synced");
  assert.equal(kept.share_token, "token");
  assert.equal(kept.is_shared, 1);
  const detached = db.getNote(fuller);
  assert.equal(detached.content, "only copy of the body");
  assert.equal(detached.transcript, "transcript");
  assert.equal(detached.cloud_id, null);
  assert.equal(detached.sync_status, "pending");
});

test("merging does not undo the kept copy's own pending clear", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCloudCopy(db, { client_note_id: "clean", cloud_id: "cloud-1", content: "old text" });
  const cleared = insertCloudCopy(db, {
    client_note_id: "cleared",
    cloud_id: "cloud-1",
    content: "",
    content_sync_operation: "clear",
    sync_status: "pending",
  });

  db.mergeDuplicateCloudNotes();

  assert.equal(db.getNote(cleared).content, "");
  assert.equal(noteCount(db), 1);
});

test("merging folds a copy with no account into the one account holding the note", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCloudCopy(db, { client_note_id: "legacy", cloud_id: "cloud-1" });
  insertCloudCopy(db, { client_note_id: "attributed", cloud_id: "cloud-1", account_id: "a" });
  insertCloudCopy(db, { client_note_id: "legacy-2", cloud_id: "cloud-2" });
  insertCloudCopy(db, { client_note_id: "a-1", cloud_id: "cloud-2", account_id: "a" });
  insertCloudCopy(db, { client_note_id: "a-2", cloud_id: "cloud-2", account_id: "a" });
  insertCloudCopy(db, { client_note_id: "b-1", cloud_id: "cloud-2", account_id: "b" });

  db.mergeDuplicateCloudNotes();

  assert.deepEqual(
    copiesOf(db, "cloud-1").map((note) => note.account_id),
    ["a"]
  );
  assert.deepEqual(
    copiesOf(db, "cloud-2")
      .map((note) => note.account_id ?? "none")
      .sort(),
    ["a", "b", "none"],
    "with two accounts each keeps its own and the unowned row stays out"
  );
});

test("a copy with no base never overwrites the cloud note through a current sibling", (t) => {
  const db = createDb(t);
  if (!db) return;
  const current = insertCloudCopy(db, {
    client_note_id: "current",
    cloud_id: "cloud-1",
    content: "newest text",
    cloud_revision: 7,
    cloud_updated_at: "2026-07-20T12:00:00.000Z",
  });
  const stale = insertCloudCopy(db, {
    client_note_id: "stale",
    cloud_id: "cloud-1",
    content: "stale text",
    sync_status: "pending",
    cloud_updated_at: null,
  });

  db.mergeDuplicateCloudNotes();

  const kept = db.getNote(current);
  assert.equal(kept.content, "newest text");
  assert.equal(kept.sync_status, "synced", "nothing to push over the newest text");
  assert.equal(db.getNote(stale).cloud_id, null);
  assert.equal(db.getNote(stale).content, "stale text");
});

test("unpushed text that differs reaches the cloud as a note of its own", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "cloud" });
  await service.syncAll(true);
  const [keyed] = copiesOf(db, row.id);
  updateNote(db, keyed.id, { sync_status: "pending", updated_at: LOCAL_LATE });
  const other = insertCloudCopy(db, {
    client_note_id: "edited-copy",
    cloud_id: row.id,
    title: "Keyed",
    content: "only here",
    sync_status: "pending",
    cloud_create_attempted: 1,
  });
  // A difference only in surrounding blanks isn't an edit.
  insertCloudCopy(db, {
    client_note_id: "same-copy",
    cloud_id: row.id,
    title: "Keyed",
    content: "cloud\n",
    sync_status: "pending",
  });

  db.mergeDuplicateCloudNotes();
  assert.deepEqual(
    copiesOf(db, row.id).map((note) => note.id),
    [keyed.id]
  );

  await service.syncAll(true);

  const detached = db.getNote(other);
  assert.equal(detached.sync_status, "synced");
  assert.ok(detached.cloud_id);
  assert.notEqual(detached.cloud_id, row.id);
  assert.equal(detached.content, "only here");
  assert.equal(noteCount(db), 2, "a blank difference made no note of its own");
});

test("a detached team copy moves to Personal rather than publish old text to the team", (t) => {
  const db = createDb(t);
  if (!db) return;
  const teamSpace = db.db
    .prepare("INSERT INTO spaces (name, kind) VALUES ('Team', 'team')")
    .run().lastInsertRowid;
  const kept = insertCloudCopy(db, {
    client_note_id: "kept",
    cloud_id: "cloud-1",
    space_id: teamSpace,
    sync_status: "pending",
    updated_at: LOCAL_LATE,
  });
  const draft = insertCloudCopy(db, {
    client_note_id: "draft",
    cloud_id: "cloud-1",
    content: "old draft",
    space_id: teamSpace,
    sync_status: "error",
  });
  const chat = db.db
    .prepare("INSERT INTO agent_conversations (title, note_id, space_id) VALUES ('Chat', ?, ?)")
    .run(draft, teamSpace).lastInsertRowid;

  db.mergeDuplicateCloudNotes();

  assert.deepEqual(
    copiesOf(db, "cloud-1").map((note) => note.id),
    [kept]
  );
  const moved = db.getNote(draft);
  assert.equal(moved.content, "old draft");
  assert.equal(moved.space_id, db.getPrivateSpaceId());
  assert.equal(moved.folder_id, null);
  const movedChat = db.db
    .prepare("SELECT note_id, space_id FROM agent_conversations WHERE id = ?")
    .get(chat);
  assert.equal(movedChat.note_id, draft);
  assert.equal(movedChat.space_id, null);
});

test("a kept tombstone is queued so the delete still reaches the cloud", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "body" });
  for (const key of ["first", "second"]) {
    insertCloudCopy(db, {
      client_note_id: key,
      cloud_id: row.id,
      sync_status: "error",
      deleted_at: LOCAL_LATE,
    });
  }

  db.mergeDuplicateCloudNotes();
  await service.syncAll(true);

  assert.equal(cloud.logFor("/api/notes/delete").length, 1);
});

test("merging compares timestamps as instants and survives one failing group", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCloudCopy(db, {
    client_note_id: "iso",
    cloud_id: "cloud-1",
    updated_at: "2026-07-20T11:00:00.000Z",
  });
  const later = insertCloudCopy(db, {
    client_note_id: "later",
    cloud_id: "cloud-1",
    updated_at: "2026-07-20 12:00:00",
  });
  insertCloudCopy(db, { client_note_id: "boom", cloud_id: "cloud-0", cloud_revision: 1 });
  insertCloudCopy(db, { client_note_id: "goes-first", cloud_id: "cloud-0", cloud_revision: 5 });
  insertCloudCopy(db, { client_note_id: "keeper", cloud_id: "cloud-0", cloud_revision: 9 });
  db.db.exec(`CREATE TRIGGER block_merge BEFORE DELETE ON notes WHEN OLD.client_note_id = 'boom'
    BEGIN SELECT RAISE(ABORT, 'boom'); END`);

  db.mergeDuplicateCloudNotes();

  assert.deepEqual(
    copiesOf(db, "cloud-1").map((note) => note.id),
    [later]
  );
  assert.equal(copiesOf(db, "cloud-0").length, 3, "the failing group rolls back whole");
});

test("a rejected create holds its group, and the merge reports what it removed", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCloudCopy(db, { client_note_id: "plain", cloud_id: "cloud-1" });
  insertCloudCopy(db, {
    client_note_id: "rejected",
    cloud_id: "cloud-1",
    cloud_create_rejected: 1,
  });
  const removed = insertCloudCopy(db, { client_note_id: "older", cloud_id: "cloud-2" });
  insertCloudCopy(db, { client_note_id: "newer", cloud_id: "cloud-2", cloud_revision: 2 });

  assert.deepEqual(db.mergeDuplicateCloudNotes(), [removed]);
  assert.equal(copiesOf(db, "cloud-1").length, 2);
});

test("cloud-id matching stays inside the active account", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const theirs = insertCloudCopy(db, {
    client_note_id: "theirs",
    cloud_id: "cloud-1",
    account_id: "account-b",
    content: "their unpushed work",
    sync_status: "pending",
  });

  assert.equal(db.getNoteForCloudRow("cloud-key", "cloud-1"), null);
  const mine = db.upsertNoteFromCloud(
    {
      id: "cloud-1",
      client_note_id: "cloud-key",
      title: "Shared",
      content: "cloud",
      created_at: "2026-07-20T09:00:00.000Z",
      updated_at: "2026-07-20T09:00:00.000Z",
    },
    null,
    db.getPrivateSpaceId()
  );

  assert.notEqual(mine.id, theirs);
  const untouched = db.db.prepare("SELECT * FROM notes WHERE id = ?").get(theirs);
  assert.equal(untouched.content, "their unpushed work");
  assert.equal(untouched.client_note_id, "theirs");
});

test("cloud-id lookup reports a held copy, prefers a live one, ignores another row's key", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCloudCopy(db, {
    client_note_id: "tombstone",
    cloud_id: "cloud-1",
    deleted_at: LOCAL_LATE,
  });
  const live = insertCloudCopy(db, { client_note_id: "live", cloud_id: "cloud-1" });
  assert.equal(db.getNoteForCloudRow(null, "cloud-1").id, live);

  const journaled = insertCloudCopy(db, { client_note_id: "journaled", cloud_id: "cloud-2" });
  db.db
    .prepare(
      `INSERT INTO optimistic_folder_delete_rows
         (folder_id, entity_type, entity_id, original_sync_status)
       VALUES (1, 'note', ?, 'synced')`
    )
    .run(journaled);
  assert.equal(db.getNoteForCloudRow("no-such-key", "cloud-2").folder_delete_pending, 1);

  const other = insertCloudCopy(db, { client_note_id: "shared-key", cloud_id: "cloud-3" });
  assert.equal(db.getNoteForCloudRow("shared-key", "cloud-4"), null);
  assert.equal(db.getNoteForCloudRow("shared-key", "cloud-3").id, other);
});

test("adopting a key settles a conflict left under it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "fresh" });
  insertCloudCopy(db, {
    client_note_id: "local-key",
    cloud_id: row.id,
    content: "old",
    cloud_updated_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01 00:00:00",
  });
  addNoteConflict("cloud-key", row);

  await service.syncAll(true);

  assert.equal(copiesOf(db, row.id)[0].client_note_id, "cloud-key");
  assert.ok(!readNoteConflictIds().has("cloud-key"));
});

test("a skipped upsert leaves another row's conflict alone", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "held-key", title: "Cloud", content: "fresh" });
  // The local row for this cloud note has its own key, and another local row
  // already holds the cloud row's key for a different cloud note.
  insertCloudCopy(db, {
    client_note_id: "local-key",
    cloud_id: row.id,
    content: "old",
    cloud_updated_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01 00:00:00",
  });
  insertCloudCopy(db, { client_note_id: "held-key", cloud_id: "another-cloud-note" });
  addNoteConflict("held-key", row);

  await service.syncAll(true);

  assert.ok(readNoteConflictIds().has("held-key"));
  assert.equal(copiesOf(db, row.id)[0].client_note_id, "local-key");
});

test("clean past versions leave one note of their own, and a blank copy leaves none", (t) => {
  const db = createDb(t);
  if (!db) return;
  const kept = insertCloudCopy(db, {
    client_note_id: "kept",
    cloud_id: "cloud-1",
    content: "",
    cloud_revision: 6,
  });
  const newestVersion = insertCloudCopy(db, {
    client_note_id: "v3",
    cloud_id: "cloud-1",
    content: "version 3",
    cloud_revision: 3,
  });
  for (const revision of [2, 1]) {
    insertCloudCopy(db, {
      client_note_id: `v${revision}`,
      cloud_id: "cloud-1",
      content: `version ${revision}`,
      cloud_revision: revision,
    });
  }
  insertCloudCopy(db, {
    client_note_id: "pending-clear",
    cloud_id: "cloud-1",
    title: "Copy",
    content: "",
    content_sync_operation: "clear",
    sync_status: "pending",
    cloud_revision: 1,
  });

  db.mergeDuplicateCloudNotes();

  assert.deepEqual(db.db.prepare("SELECT id, content FROM notes ORDER BY id").all(), [
    { id: kept, content: "" },
    { id: newestVersion, content: "version 3" },
  ]);
});

test("a pending clear on a copy leaves no note of its own", (t) => {
  const db = createDb(t);
  if (!db) return;
  const kept = insertCloudCopy(db, {
    client_note_id: "kept",
    cloud_id: "cloud-1",
    content: "cloud text",
    cloud_revision: 6,
  });
  insertCloudCopy(db, {
    client_note_id: "pending-clear",
    cloud_id: "cloud-1",
    content: "",
    content_sync_operation: "clear",
    sync_status: "pending",
    cloud_revision: 1,
  });

  db.mergeDuplicateCloudNotes();

  assert.deepEqual(
    db.db
      .prepare("SELECT id FROM notes")
      .all()
      .map((note) => note.id),
    [kept]
  );
});

test("a detached team copy takes the account that can see it", (t) => {
  const db = createDb(t);
  if (!db) return;
  const insertSpace = db.db.prepare("INSERT INTO spaces (name, kind) VALUES (?, 'team')");
  const insertMember = db.db.prepare(
    "INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)"
  );
  const solo = insertSpace.run("Solo").lastInsertRowid;
  insertMember.run(solo, "account-a");
  const shared = insertSpace.run("Shared").lastInsertRowid;
  insertMember.run(shared, "account-a");
  insertMember.run(shared, "account-b");
  const owned = insertSpace.run("Owned").lastInsertRowid;

  const detached = [
    ["solo", solo, null],
    ["shared", shared, null],
    ["owned", owned, "account-c"],
  ].map(([name, space, account]) => {
    insertCloudCopy(db, {
      client_note_id: `${name}-kept`,
      cloud_id: `cloud-${name}`,
      space_id: space,
      sync_status: "pending",
      updated_at: LOCAL_LATE,
    });
    return insertCloudCopy(db, {
      client_note_id: `${name}-draft`,
      cloud_id: `cloud-${name}`,
      content: `${name} draft`,
      space_id: space,
      account_id: null,
      sync_status: "error",
    });
  });
  db.db
    .prepare("UPDATE notes SET account_id = 'account-c' WHERE client_note_id = 'owned-kept'")
    .run();

  db.mergeDuplicateCloudNotes();

  assert.deepEqual(
    detached.map(
      (id) => db.db.prepare("SELECT account_id FROM notes WHERE id = ?").get(id).account_id
    ),
    ["account-a", null, "account-c"],
    "a space two accounts share has no one owner to pick"
  );
});

test("a chat that follows its note into another space drops the old scope", (t) => {
  const db = createDb(t);
  if (!db) return;
  const teamSpace = db.db
    .prepare("INSERT INTO spaces (name, kind) VALUES ('Team', 'team')")
    .run().lastInsertRowid;
  const teamCopy = insertCloudCopy(db, {
    client_note_id: "team-copy",
    cloud_id: "cloud-1",
    space_id: teamSpace,
    cloud_revision: 1,
  });
  const kept = insertCloudCopy(db, {
    client_note_id: "private-copy",
    cloud_id: "cloud-1",
    cloud_revision: 2,
  });
  const chat = db.db
    .prepare("INSERT INTO agent_conversations (title, note_id, space_id) VALUES ('Chat', ?, ?)")
    .run(teamCopy, teamSpace).lastInsertRowid;

  db.mergeDuplicateCloudNotes();

  assert.deepEqual(
    db.db.prepare("SELECT note_id, space_id FROM agent_conversations WHERE id = ?").get(chat),
    { note_id: kept, space_id: null }
  );
});

// A desktop that synced before pulls matched by cloud id: its cursor has passed
// the delete, and nothing since has shown the copy that delete was for.
function syncedPastTheFeed(service) {
  localStorageStub.setItem("lastSyncedAt.notes", new Date(Date.now() + 1000).toISOString());
  localStorageStub.removeItem("noteFeedReplay.v1");
  service.noteFeedReplayTried.clear();
}

test("replaying the feed once retires a copy whose delete the cursor had passed", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Gone", content: "body" });
  await service.syncAll(true);
  updateNote(db, copiesOf(db, row.id)[0].id, { client_note_id: "local-key" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
  syncedPastTheFeed(service);
  assert.equal(noteCount(db), 1, "the ghost is there before the replay");

  await service.syncAll(true);

  assert.equal(noteCount(db), 0);
  const replays = () =>
    cloud.logFor("/api/notes/list").filter((call) => call.path.includes("1970-01-01")).length;
  assert.equal(replays(), 1);

  const fresh = new SyncService();
  t.after(() => stopSyncTimers(fresh));
  await fresh.syncAll(true);
  assert.equal(replays(), 1, "once per install, not per session");
});

test("the replay leaves a copy with unpushed text to its push", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Gone", content: "body" });
  await service.syncAll(true);
  const [copy] = copiesOf(db, row.id);
  updateNote(db, copy.id, { client_note_id: "local-key" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
  syncedPastTheFeed(service);
  updateNote(db, copy.id, { content: "unpushed", sync_status: "pending" });

  await service.syncAll(true);

  assert.equal(db.getNote(copy.id).content, "unpushed");
});

test("a note the feed no longer returns stays, as it may exist and be unreadable", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  cloud.seedNote({ client_note_id: "live", title: "Live", content: "body" });
  await service.syncAll(true);
  const absent = insertCloudCopy(db, {
    client_note_id: "absent",
    cloud_id: "absent-cloud",
    cloud_updated_at: "2020-01-01T00:00:00.000Z",
  });
  syncedPastTheFeed(service);

  await service.syncAll(true);

  assert.ok(db.getNote(absent));
});

test("a failed replay is retried next session, and stops after a few attempts", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Gone", content: "body" });
  await service.syncAll(true);
  updateNote(db, copiesOf(db, row.id)[0].id, { client_note_id: "local-key" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
  syncedPastTheFeed(service);
  const isReplay = (call) => call.path.includes("1970-01-01");
  const replays = () => cloud.logFor("/api/notes/list").filter(isReplay).length;
  cloud.failWith((call) => call.path.includes("/api/notes/list") && isReplay(call), {
    status: 500,
  });

  await service.syncAll(true);
  await service.syncAll(true);
  assert.equal(noteCount(db), 1, "a failed replay applies nothing");
  assert.equal(replays(), 1, "once a session");

  for (const expected of [2, 3, 3]) {
    const session = new SyncService();
    t.after(() => stopSyncTimers(session));
    await session.syncAll(true);
    assert.equal(replays(), expected);
  }

  localStorageStub.setItem("noteFeedReplay.v1", "2");
  cloud.clearFailures();
  const last = new SyncService();
  t.after(() => stopSyncTimers(last));
  await last.syncAll(true);
  assert.equal(noteCount(db), 0, "a later attempt succeeds");
  assert.equal(localStorageStub.getItem("noteFeedReplay.v1"), "3");
});

test("a first sync doesn't replay the feed", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, service } = ctx;

  cloud.seedNote({ client_note_id: "live", title: "Live", content: "body" });
  await service.syncAll(true);

  assert.equal(localStorageStub.getItem("noteFeedReplay.v1"), "3");
  assert.ok(!cloud.logFor("/api/notes/list").some((call) => call.path.includes("1970-01-01")));
});

test("a pull landing on a just-deleted note keeps its delete queued", (t) => {
  const db = createDb(t);
  if (!db) return;
  const id = insertCloudCopy(db, {
    client_note_id: "racing",
    cloud_id: "cloud-1",
    sync_status: "pending",
    deleted_at: LOCAL_LATE,
  });

  db.upsertNoteFromCloud(
    {
      id: "cloud-1",
      client_note_id: "racing",
      title: "Copy",
      content: "newer",
      created_at: "2026-07-20T09:00:00.000Z",
      updated_at: "2026-07-20T13:00:00.000Z",
    },
    null,
    db.getPrivateSpaceId()
  );

  assert.deepEqual(
    db.getPendingNoteDeletes().map((note) => note.id),
    [id]
  );
});
