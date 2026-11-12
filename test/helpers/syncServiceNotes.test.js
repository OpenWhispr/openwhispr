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
const { createFakeCloud, createAccountCloud } = require("./harness/fakeCloud.js");
const { TEAM_SPACE, joinTeamSpace, saveNoteIn } = require("./harness/teamSpace.js");
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

// With team, the device is in a teamspace the fake cloud files its rows into:
// private notes stay on the device (D2), so the note sync machinery a test
// drives end to end runs on a teamspace's notes.
async function setup(t, { team = false } = {}) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  const api = createElectronApi(db, { cloud });
  windowStub.electronAPI = api;
  const teamSpace = team ? joinTeamSpace(db, cloud) : null;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, cloud, api, service, team: teamSpace };
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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  // The meeting shell exactly as meetingDetectionEngine.js creates it.
  const shell = saveNoteIn(db, ctx.team.id, "Weekly sync", "", "meeting").note;
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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  const shell = saveNoteIn(db, ctx.team.id, "Weekly sync", "", "meeting").note;
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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  for (let i = 0; i < BATCH_SIZE + 1; i += 1) {
    saveNoteIn(db, ctx.team.id, `Note ${i}`, `body ${i}`);
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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  for (let i = 0; i < BATCH_SIZE + 1; i += 1) {
    saveNoteIn(db, ctx.team.id, `Note ${i}`, `body ${i}`);
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
  const ctx = await setup(t, { team: true });
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
    const local = saveNoteIn(db, ctx.team.id, `Local ${c.key}`, `local body ${c.key}`).note;
    updateNote(db, local.id, {
      client_note_id: cloudRow.client_note_id,
      cloud_id: cloudRow.id,
      owner_user_id: cloudRow.user_id,
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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const cloudRow = cloud.seedNote({
    client_note_id: "client-tombstoned",
    title: "Deleted elsewhere",
    content: "gone",
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: "2026-07-20T08:00:00.000Z",
  });
  const local = saveNoteIn(db, ctx.team.id, "Deleted elsewhere", "gone").note;
  updateNote(db, local.id, {
    client_note_id: cloudRow.client_note_id,
    cloud_id: cloudRow.id,
    owner_user_id: cloudRow.user_id,
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
  const ctx = await setup(t, { team: true });
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
  const ctx = await setup(t, { team: true });
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

test("the first pull pages 120 cloud notes across tied timestamps and stamps its cursor", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const base = Date.parse("2026-07-20T08:00:00.000Z");
  const seeded = [];
  for (let i = 0; i < 120; i += 1) {
    const at = new Date(base + Math.floor(i / 60) * 60000).toISOString();
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
  assert.equal(queryParam(listCalls[0].path, "since"), "1970-01-01T00:00:00.000Z");
  assert.equal(queryParam(listCalls[0].path, "since_id"), null);
  // A tied timestamp spans each page boundary; the id must carry the rest.
  assert.equal(queryParam(listCalls[1].path, "since"), seeded[49].updated_at);
  assert.equal(queryParam(listCalls[1].path, "since_id"), seeded[49].id);
  assert.equal(queryParam(listCalls[2].path, "since"), seeded[99].updated_at);
  assert.equal(queryParam(listCalls[2].path, "since_id"), seeded[99].id);

  assert.equal(noteCount(db), 120, "every page must be applied exactly once");
  assert.equal(db.getNoteByClientId("client-000").content, "cloud body 0");
  assert.equal(db.getNoteByClientId("client-119").content, "cloud body 119");
  assert.ok(
    Date.parse(localStorageStub.getItem("lastSyncedAt.notes")) > 0,
    "a clean pull stamps the cursor"
  );
});

test("a mid-pagination failure leaves the pull cursor unstamped", async (t) => {
  const ctx = await setup(t, { team: true });
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

  // Only pages after the first carry the row id of a completed page.
  cloud.failNext(
    (call) => call.path.startsWith("/api/notes/list") && call.path.includes("since_id="),
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

// What useAuth leaves behind on an account boundary: the main process scopes the
// local rows to the account and the renderer holds a validated session for it.
async function signInAs(t, db, cloud, accountId) {
  db.setActiveAccountId(accountId);
  windowStub.electronAPI = createElectronApi(db, { cloud });
  await establishValidatedAuth(accountId);
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return service;
}

const LIST_PATHS = [
  "/api/folders/list",
  "/api/notes/list",
  "/api/conversations/list",
  "/api/transcriptions/list",
  "/api/dictionary/list",
  "/api/snippets/list",
];

test("the first pass after an account switch pulls the new account's older chats, not with A's cursors", async (t) => {
  const db = createDb(t);
  if (!db) return;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  const accountA = await signInAs(t, db, createAccountCloud(), "account-a");
  // Dictionary and snippet cursors only move when a pull sees entries, which
  // the fake cloud never serves; stamp them as such a pull would have.
  localStorageStub.setItem("lastSyncedAt.dictionary", "2026-02-01T00:00:00.000Z");
  localStorageStub.setItem("lastSyncedAt.dictionary.id", "dict-a");
  localStorageStub.setItem("lastSyncedAt.snippets", "2026-02-01T00:00:00.000Z");
  localStorageStub.setItem("lastSyncedAt.snippets.id", "snippet-a");
  await accountA.syncAll(true);
  assert.ok(
    Date.parse(localStorageStub.getItem("lastSyncedAt.notes")) > 0,
    "account A's pass stamps its notes cursor"
  );

  // Written on account B's other devices before A's pass stamped its cursors.
  const cloudB = createAccountCloud();
  cloudB.seedNote({
    client_note_id: "b-note",
    title: "B's note",
    content: "written on B's laptop",
    created_at: "2026-01-05T09:00:00.000Z",
    updated_at: "2026-01-05T09:00:00.000Z",
  });
  cloudB.seedConversation({
    client_conversation_id: "b-conversation",
    title: "B's chat",
    created_at: "2026-01-05T09:00:00.000Z",
    updated_at: "2026-01-05T09:00:00.000Z",
    messages: [{ role: "user", content: "hello from B", created_at: "2026-01-05T09:00:00.000Z" }],
  });

  await accountA.purgeTeamSpacesForSignOut();
  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);

  // B's private note is left to the one-time import: private notes stay on
  // the devices that hold them (D2).
  assert.deepEqual(db.getNotes(null, 100, null), []);
  assert.equal(db.getConversationByClientId("b-conversation")?.title, "B's chat");
  for (const path of LIST_PATHS) {
    assert.notEqual(
      queryParam(cloudB.logFor(path)[0].path, "since"),
      "2026-02-01T00:00:00.000Z",
      `${path} must not carry account A's cursor`
    );
  }
});

test("signing out and back in as the same account keeps its cursors for deletes made meanwhile", async (t) => {
  const db = createDb(t);
  if (!db) return;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  // A known local chat remains Backup eligible; newly restored history is device-only.
  const cloud = createAccountCloud();
  const firstSession = await signInAs(t, db, cloud, "account-a");
  const local = db.createAgentConversation("A's chat");
  db.addAgentMessage(local.id, "user", "hello");
  const clientId = db.getAgentConversation(local.id).client_conversation_id;
  assert.equal(db.getAgentConversation(local.id).device_only, 0);
  await firstSession.syncAll(true);
  assert.equal(db.getConversationByClientId(clientId)?.title, "A's chat");
  const seeded = cloud.conversation(clientId);
  assert.ok(seeded, "the local chat was backed up before signing out");

  await firstSession.purgeTeamSpacesForSignOut();
  await new Promise((resolve) => setTimeout(resolve, 5));
  cloud.deleteConversation(seeded.id);

  // A cursor-less pull lists live rows only, so the tombstone arrives through
  // the kept delta cursor or not at all.
  const secondSession = await signInAs(t, db, cloud, "account-a");
  await secondSession.syncAll(true);
  assert.equal(
    db.getConversationByClientId(clientId),
    null,
    "a chat deleted elsewhere while signed out must leave this device"
  );
});

test("an account returning after another account synced gets its cursors back", async (t) => {
  const db = createDb(t);
  if (!db) return;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  const cloudA = createAccountCloud();
  const seeded = cloudA.seedNote({
    client_note_id: "a-note",
    title: "A's note",
    content: "deleted on A's laptop while B used this device",
    created_at: "2026-01-05T09:00:00.000Z",
    updated_at: "2026-01-05T09:00:00.000Z",
  });
  const firstA = await signInAs(t, db, cloudA, "account-a");
  await firstA.syncAll(true);
  const cursorA = localStorageStub.getItem("lastSyncedAt.notes");
  await firstA.purgeTeamSpacesForSignOut();

  const accountB = await signInAs(t, db, createAccountCloud(), "account-b");
  await accountB.syncAll(true);
  await accountB.purgeTeamSpacesForSignOut();
  await cloudA.request({ method: "DELETE", path: "/api/notes/delete", body: { id: seeded.id } });

  const secondA = await signInAs(t, db, cloudA, "account-a");
  await secondA.syncAll(true);
  const pulls = cloudA.logFor("/api/notes/list");
  assert.equal(queryParam(pulls[pulls.length - 1].path, "since"), cursorA);
  assert.deepEqual(
    db.getNotes(null, 100, null).map((note) => note.title),
    [],
    "a note A deleted elsewhere while B used this device must leave it"
  );
});

test("a dictionary or snippet edit before the new account's first pass skips the old account's cursors", async (t) => {
  const db = createDb(t);
  if (!db) return;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  const accountA = await signInAs(t, db, createAccountCloud(), "account-a");
  localStorageStub.setItem("lastSyncedAt.dictionary", "2026-02-01T00:00:00.000Z");
  localStorageStub.setItem("lastSyncedAt.dictionary.id", "dict-a");
  localStorageStub.setItem("lastSyncedAt.snippets", "2026-02-01T00:00:00.000Z");
  localStorageStub.setItem("lastSyncedAt.snippets.id", "snippet-a");
  await accountA.syncAll(true);
  await accountA.purgeTeamSpacesForSignOut();

  const cloudB = createAccountCloud();
  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncDictionaryNow();
  await accountB.syncSnippetsNow();
  for (const path of ["/api/dictionary/list", "/api/snippets/list"]) {
    assert.notEqual(
      queryParam(cloudB.logFor(path)[0].path, "since"),
      "2026-02-01T00:00:00.000Z",
      path
    );
  }
});

test("a pass queued before an account switch leaves the new account's cursors alone", async (t) => {
  const db = createDb(t);
  if (!db) return;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  const accountA = await signInAs(t, db, createAccountCloud(), "account-a");
  await accountA.syncAll(true);
  const cursorA = localStorageStub.getItem("lastSyncedAt.notes");

  const release = await acquireLock(SYNC_ALL_LOCK);
  const stalePass = accountA.syncAll(true);
  // Account B signs in and another window claims the cursors for it while
  // A's pass still waits for the lock.
  await signInAs(t, db, createAccountCloud(), "account-b");
  localStorageStub.setItem(
    "lastSyncedAt.byAccount.account-a",
    JSON.stringify({ "lastSyncedAt.notes": cursorA })
  );
  localStorageStub.setItem("lastSyncedAt.accountId", "account-b");
  localStorageStub.setItem("lastSyncedAt.notes", "2026-03-01T00:00:00.000Z");
  release();
  await stalePass;

  assert.equal(localStorageStub.getItem("lastSyncedAt.accountId"), "account-b");
  assert.equal(localStorageStub.getItem("lastSyncedAt.notes"), "2026-03-01T00:00:00.000Z");
  assert.equal(localStorageStub.getItem("lastSyncedAt.byAccount.account-b"), null);
  assert.deepEqual(JSON.parse(localStorageStub.getItem("lastSyncedAt.byAccount.account-a")), {
    "lastSyncedAt.notes": cursorA,
  });
});

test("a dictionary or snippet edit claims the cursors only once another window's pass ends", async (t) => {
  const db = createDb(t);
  if (!db) return;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  const accountA = await signInAs(t, db, createAccountCloud(), "account-a");
  await accountA.syncAll(true);
  await accountA.purgeTeamSpacesForSignOut();
  const accountB = await signInAs(t, db, createAccountCloud(), "account-b");

  for (const syncNow of ["syncDictionaryNow", "syncSnippetsNow"]) {
    localStorageStub.setItem("lastSyncedAt.accountId", "account-a");
    const release = await acquireLock(SYNC_ALL_LOCK);
    const edit = accountB[syncNow]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      localStorageStub.getItem("lastSyncedAt.accountId"),
      "account-a",
      `${syncNow} must not claim while the lock is held`
    );
    release();
    await edit;
    assert.equal(localStorageStub.getItem("lastSyncedAt.accountId"), "account-b", syncNow);
  }
});

// Builds before cursors recorded their account left them unowned.
function seedUnownedCursors() {
  localStorageStub.setItem("lastSyncedAt.folders", "2026-06-01T00:00:00.000Z");
  localStorageStub.setItem("lastSyncedAt.notes", "2026-06-01T00:00:00.000Z");
  localStorageStub.setItem("lastSyncedAt.conversations", "2026-06-01T00:00:00.000Z");
}

test("unowned cursors on a device another account used get one snapshot pull", async (t) => {
  const db = createDb(t);
  if (!db) return;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  db.setActiveAccountId("account-a");
  db.saveNote("A's draft", "left by account A", "personal");
  seedUnownedCursors();
  const cloudB = createAccountCloud();
  cloudB.seedNote({
    client_note_id: "b-note",
    title: "B's note",
    content: "older than the inherited cursor",
    created_at: "2026-01-05T09:00:00.000Z",
    updated_at: "2026-01-05T09:00:00.000Z",
  });
  cloudB.seedConversation({
    client_conversation_id: "b-chat",
    title: "B's chat",
    created_at: "2026-01-05T09:00:00.000Z",
    updated_at: "2026-01-05T09:00:00.000Z",
    messages: [{ role: "user", content: "older too", created_at: "2026-01-05T09:00:00.000Z" }],
  });

  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);
  assert.equal(db.getConversationByClientId("b-chat")?.title, "B's chat");
  assert.deepEqual(db.getNotes(null, 100, null), [], "B's private note stays in the cloud (D2)");
  assert.equal(localStorageStub.getItem("lastSyncedAt.accountId"), "account-b");

  await accountB.syncAll(true);
  const snapshotPulls = cloudB
    .logFor("/api/notes/list")
    .filter((entry) => queryParam(entry.path, "since") === null);
  assert.equal(snapshotPulls.length, 1, "the snapshot runs once");
});

test("unowned cursors on a device only one account used download nothing extra", async (t) => {
  const db = createDb(t);
  if (!db) return;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  db.setActiveAccountId("account-a");
  db.saveNote("A's note", "synced before the upgrade", "personal");
  seedUnownedCursors();
  const cloud = createFakeCloud();
  const accountA = await signInAs(t, db, cloud, "account-a");
  await accountA.syncAll(true);

  // Folders are left out: pushing the default folders lists them without a cursor.
  const sinces = (path) => cloud.logFor(path).map((entry) => queryParam(entry.path, "since"));
  assert.deepEqual(
    sinces("/api/conversations/list"),
    ["2026-06-01T00:00:00.000Z"],
    "conversations pull once, from the inherited cursor"
  );
  // The second read is the note feed's one-time replay, which every upgraded
  // device runs; the unowned cursors add no snapshot pull of their own.
  assert.deepEqual(
    sinces("/api/notes/list"),
    ["2026-06-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z"],
    "notes pull from the inherited cursor, with no snapshot"
  );
});

test("a pass requested during a dictionary edit runs once the edit finishes", async (t) => {
  const db = createDb(t);
  if (!db) return;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  const cloud = createFakeCloud();
  const service = await signInAs(t, db, cloud, "account-a");
  const release = await acquireLock(SYNC_ALL_LOCK);
  const edit = service.syncDictionaryNow();
  await service.syncAll();
  assert.equal(cloud.logFor("/api/notes/list").length, 0, "the pass waits behind the edit");
  release();
  await edit;
  assert.equal(cloud.logFor("/api/notes/list").length, 1);
});

test("canSync gating: sign-out blocks every call; no gate lets a private note push", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud } = ctx;
  const note = db.saveNote("Pending note", "body", "personal").note;
  const teamNote = saveNoteIn(db, ctx.team.id, "Team note", "body").note;

  enableSync();
  localStorageStub.removeItem("isSignedIn");
  const signedOutService = new SyncService();
  await signedOutService.syncAll(true);
  stopSyncTimers(signedOutService);
  assert.equal(cloud.log.length, 0, "sync ran while signed out");
  assert.equal(localStorageStub.getItem("lastSyncedAt"), null);

  // Collaboration is free, so an unsubscribed account still syncs shared
  // notes and team spaces. Nothing private leaves the machine.
  enableSync();
  localStorageStub.removeItem("isSubscribed");
  const freeService = new SyncService();
  await freeService.syncAll(true);
  stopSyncTimers(freeService);
  assert.ok(cloud.log.length > 0, "a free signed-in account must still sync collaboration");
  assert.equal(db.getNote(teamNote.id).sync_status, "synced", "the teamspace note pushes");
  assert.equal(db.getNote(note.id).sync_status, "pending");

  // Backup off is not sign-out: team-space membership still syncs, but nothing
  // private may leave the machine.
  enableSync();
  localStorageStub.removeItem("cloudBackupEnabled");
  const teamOnlyService = new SyncService();
  await teamOnlyService.syncAll(true);
  stopSyncTimers(teamOnlyService);
  assert.equal(db.getNote(note.id).sync_status, "pending");

  // With every gate open the pass does real work, and the private note still
  // stays on this device (D2).
  enableSync();
  const mark = cloud.log.length;
  const fullService = new SyncService();
  await fullService.syncAll(true);
  stopSyncTimers(fullService);
  assert.ok(cloud.log.length > mark, "with all three keys set the same pass must do real work");
  assert.equal(db.getNote(note.id).sync_status, "pending");
  assert.equal(db.getNote(note.id).cloud_id, null);
  const sent = cloud.log.flatMap((call) =>
    call.path === "/api/notes/batch-create" ? call.body.notes.map((n) => n.client_note_id) : []
  );
  assert.deepEqual(sent, [teamNote.client_note_id], "only the teamspace note was ever sent");
});

// A private note the old Cloud Backup uploaded still carries that copy's cloud id (D32). Moved into
// a teamspace to share it, its first push must be a create carrying the whole note, under a key of
// its own (D32a). The old personal row stays as it is.
test("a private note with a Backup cloud id moves into a teamspace as a full create", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  db.setActiveWorkspaceScope({
    activeWorkspaceId: TEAM_SPACE.workspace_id,
    defaultWorkspaceId: TEAM_SPACE.workspace_id,
  });
  db.bindDefaultPrivateSpace(TEAM_SPACE.workspace_id);
  const note = db.saveNote("Roadmap", "the body on this device", "personal").note;
  const backup = cloud.seedNote({
    client_note_id: note.client_note_id,
    title: "Roadmap",
    content: "the body Backup uploaded months ago",
    space_id: null,
    workspace_id: null,
  });
  db.markNoteSynced(note.id, backup.id, backup.updated_at, "user-harness");

  assert.ok(db.updateNote(note.id, { space_id: ctx.team.id, folder_id: null }).success);
  // The push asks for a pass, which must not outlive the test's database.
  stopSyncTimers(service);
  const mark = cloud.log.length;
  const cloudId = await service.ensureNoteSynced(note.id);

  const creates = cloud.log
    .slice(mark)
    .filter((call) => call.method === "POST" && call.path === "/api/notes/create");
  assert.equal(creates.length, 1, "the share view gets its id from a create, not the old copy");
  const moved = db.getNote(note.id);
  assert.notEqual(moved.client_note_id, note.client_note_id);
  assert.equal(creates[0].body.client_note_id, moved.client_note_id);
  assert.equal(creates[0].body.content, "the body on this device");
  assert.equal(creates[0].body.space_id, TEAM_SPACE.id);
  assert.notEqual(cloudId, backup.id);
  assert.equal(cloud.note(cloudId).space_id, TEAM_SPACE.id);
  assert.equal(cloud.note(cloudId).content, "the body on this device");
  assert.equal(moved.cloud_id, cloudId);
  assert.equal(cloud.note(backup.id).space_id, null, "the old personal row is left alone");
});

test("a private note whose Backup copy was purged is created fresh in the teamspace", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  db.setActiveWorkspaceScope({
    activeWorkspaceId: TEAM_SPACE.workspace_id,
    defaultWorkspaceId: TEAM_SPACE.workspace_id,
  });
  db.bindDefaultPrivateSpace(TEAM_SPACE.workspace_id);
  const note = db.saveNote("Roadmap", "the body on this device", "personal").note;
  db.markNoteSynced(note.id, "purged-backup-copy", "2026-06-01T10:00:00.000Z", "user-harness");

  assert.ok(db.updateNote(note.id, { space_id: ctx.team.id, folder_id: null }).success);
  stopSyncTimers(service);
  const cloudId = await service.ensureNoteSynced(note.id);

  assert.ok(cloudId && cloudId !== "purged-backup-copy", `got ${cloudId}`);
  assert.equal(cloud.note(cloudId).client_note_id, db.getNote(note.id).client_note_id);
  assert.equal(cloud.note(cloudId).space_id, TEAM_SPACE.id);
  assert.equal(cloud.note(cloudId).content, "the body on this device");
});

// D32a: the API's note upsert keeps a tombstone deleted. A Backup copy deleted
// on another device stays a live private note here (personal tombstones don't
// reach private rows), so moving it into a teamspace under its old key would
// land on the tombstone, and the next pull would delete the note.
test("a private note whose Backup copy was deleted elsewhere stays live once moved into a teamspace", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  db.setActiveWorkspaceScope({
    activeWorkspaceId: TEAM_SPACE.workspace_id,
    defaultWorkspaceId: TEAM_SPACE.workspace_id,
  });
  db.bindDefaultPrivateSpace(TEAM_SPACE.workspace_id);
  const note = db.saveNote("Roadmap", "the body on this device", "personal").note;
  const backup = cloud.seedNote({
    client_note_id: note.client_note_id,
    title: "Roadmap",
    content: "the body Backup uploaded months ago",
    space_id: null,
    workspace_id: null,
  });
  db.markNoteSynced(note.id, backup.id, backup.updated_at, "user-harness");
  cloud.deleteNote(backup.id);

  assert.ok(db.updateNote(note.id, { space_id: ctx.team.id, folder_id: null }).success);
  stopSyncTimers(service);
  await service.ensureNoteSynced(note.id);
  // The harness has no shared dictionary bindings; that stage's error is noise here.
  silenceConsoleErrors(t);
  await service.syncAll(true);

  const local = db.getNote(note.id);
  assert.ok(local && !local.deleted_at, "the moved note survives the next pull");
  assert.equal(local.space_id, ctx.team.id);
  assert.ok(local.cloud_id, "the moved note has a cloud copy in the teamspace");
  const row = cloud.note(local.cloud_id);
  assert.equal(row.deleted_at, null, "the team's copy is live");
  assert.equal(row.space_id, TEAM_SPACE.id);
  assert.equal(row.content, "the body on this device");
  assert.equal(cloud.note(backup.id).deleted_at !== null, true, "the old copy stays deleted");
});

// D39: a Granola import derives the note's key from the meeting, so the same export imported on
// another device gives the same key there. That device uploaded it with Backup and deleted it later;
// this one never sent it. Moved into a teamspace under that key, the create would land on the
// other device's tombstone and the next pull would delete the note the user just shared.
test("a never-sent Granola note whose key was deleted elsewhere stays live once moved into a teamspace", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  db.setActiveWorkspaceScope({
    activeWorkspaceId: TEAM_SPACE.workspace_id,
    defaultWorkspaceId: TEAM_SPACE.workspace_id,
  });
  db.bindDefaultPrivateSpace(TEAM_SPACE.workspace_id);
  const { deterministicUuid } = await import("../../src/helpers/granolaImport.js");
  const clientNoteId = deterministicUuid("granola-doc-1");
  const imported = db.importNotes([
    {
      clientNoteId,
      sourceFile: "granola:granola-doc-1",
      title: "Kickoff",
      content: "the body on this device",
      transcript: null,
      participants: null,
      createdAt: "2026-05-01 10:00:00",
    },
  ]);
  const noteId = imported.noteIds[0];
  assert.equal(db.getNote(noteId).cloud_id, null);
  assert.equal(db.getNote(noteId).cloud_create_attempted, 0);
  const elsewhere = cloud.seedNote({
    client_note_id: clientNoteId,
    title: "Kickoff",
    content: "the body the other device uploaded",
    space_id: null,
    workspace_id: null,
  });
  cloud.deleteNote(elsewhere.id);

  assert.ok(db.updateNote(noteId, { space_id: ctx.team.id, folder_id: null }).success);
  stopSyncTimers(service);
  await service.ensureNoteSynced(noteId);
  silenceConsoleErrors(t);
  await service.syncAll(true);

  const local = db.getNote(noteId);
  assert.ok(local && !local.deleted_at, "the moved note survives the next pull");
  assert.equal(local.space_id, ctx.team.id);
  assert.notEqual(local.client_note_id, clientNoteId);
  assert.ok(local.cloud_id, "the moved note has a cloud copy in the teamspace");
  const row = cloud.note(local.cloud_id);
  assert.equal(row.deleted_at, null, "the team's copy is live");
  assert.equal(row.space_id, TEAM_SPACE.id);
  assert.equal(row.content, "the body on this device");
  assert.notEqual(
    cloud.note(elsewhere.id).deleted_at,
    null,
    "the other device's copy stays deleted"
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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const errors = silenceConsoleErrors(t);
  const note = saveNoteIn(db, ctx.team.id, "Pending note", "body").note;

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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const errors = silenceConsoleErrors(t);
  const note = saveNoteIn(db, ctx.team.id, "Pending note", "body").note;

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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const note = saveNoteIn(db, ctx.team.id, "Weekly sync", "", "meeting").note;
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
  const ctx = await setup(t, { team: true });
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
  const ctx = await setup(t, { team: true });
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
  const ctx = await setup(t, { team: true });
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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "body" });
  cloud.setNoteRevision(row.id, 3);
  insertCloudCopy(db, { client_note_id: "local-key", cloud_id: row.id, space_id: ctx.team.id });
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

for (const { name, before, changes } of [
  {
    name: "calendar unlink",
    before: { calendar_event_id: "calendar-event" },
    changes: { calendar_event_id: "" },
  },
  {
    name: "participant removal",
    before: { participants: '[{"email":"ada@example.com"}]' },
    changes: { participants: "[]" },
  },
  {
    name: "folder move",
    before: {},
    changes: {},
  },
  {
    name: "summary template change",
    before: { enhanced_content: "Summary", enhancement_template_id: "old-template" },
    changes: { enhancement_template_id: "new-template" },
  },
]) {
  test(`merging preserves a pending ${name} until cloud reconciliation`, (t) => {
    const db = createDb(t);
    if (!db) return;
    const pending = insertCloudCopy(db, {
      client_note_id: "pending-copy",
      cloud_id: "cloud-1",
      cloud_revision: 2,
      ...before,
    });
    const newest = insertCloudCopy(db, {
      client_note_id: "newest-copy",
      cloud_id: "cloud-1",
      cloud_revision: 3,
      ...before,
    });
    const updates =
      name === "folder move" ? { folder_id: db.createFolder("Destination").folder.id } : changes;
    assert.equal(db.updateNote(pending, updates).success, true);
    const snapshot = db.getNote(pending);

    assert.deepEqual(db.mergeDuplicateCloudNotes(), [newest]);
    assert.deepEqual(db.getNote(pending), snapshot, "retain the original cloud identity and base");
    assert.deepEqual(
      db.getPendingNotes().map((note) => note.id),
      [pending]
    );
    assert.equal(copiesOf(db, "cloud-1").length, 1);

    // A later server receipt settles the original operation without creating
    // another local identity or assigning a sibling's newer base to the edit.
    db.upsertNoteFromCloud(
      { ...snapshot, id: "cloud-1", revision: 4, updated_at: "2026-07-20T12:00:00.000Z" },
      snapshot.folder_id,
      snapshot.space_id
    );
    assert.deepEqual(db.mergeDuplicateCloudNotes(), []);
    assert.equal(db.getNote(pending).sync_status, "synced");
    for (const [field, value] of Object.entries(updates)) {
      assert.equal(db.getNote(pending)[field], value);
    }
    assert.equal(noteCount(db), 1);
  });
}

test("merging preserves a pending team retraction even with distinct text", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const teamSpace = db.db
    .prepare("INSERT INTO spaces (name, kind) VALUES ('Team', 'team')")
    .run().lastInsertRowid;
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(teamSpace, "account-a");
  const pending = insertCloudCopy(db, {
    client_note_id: "pending-copy",
    cloud_id: "cloud-1",
    cloud_revision: 2,
    space_id: teamSpace,
  });
  const alternate = insertCloudCopy(db, {
    client_note_id: "newest-copy",
    cloud_id: "cloud-1",
    cloud_revision: 3,
    space_id: teamSpace,
    sync_status: "pending",
  });
  // A pending retraction as builds before D31 left it: a team note moved to
  // Private with its cloud copy, its text changed too. A move can't make one
  // now; a detached copy still could not retract it.
  db.db
    .prepare(
      "UPDATE notes SET space_id = ?, folder_id = NULL, left_team = 1, sync_status = 'pending', content = 'Private edit' WHERE id = ?"
    )
    .run(db.getPrivateSpaceId(), pending);
  const snapshot = db.getNote(pending);
  assert.equal(snapshot.left_team, 1);

  assert.deepEqual(db.mergeDuplicateCloudNotes(), []);
  assert.deepEqual(db.getNote(pending), snapshot);
  assert.deepEqual(
    db.getPendingNotes("team").map((note) => note.id),
    [pending]
  );
  assert.equal(copiesOf(db, "cloud-1").length, 1);
  assert.equal(db.getNote(alternate).cloud_id, null);
  assert.equal(db.getNote(alternate).space_id, db.getPrivateSpaceId());
});

test("merging preserves distinct pending metadata as independent recovery notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const current = insertCloudCopy(db, {
    client_note_id: "current",
    cloud_id: "cloud-1",
    cloud_revision: 4,
    calendar_event_id: "new-event",
    sync_status: "pending",
  });
  const alternate = insertCloudCopy(db, {
    client_note_id: "alternate",
    cloud_id: "cloud-1",
    cloud_revision: 2,
    calendar_event_id: "",
    sync_status: "error",
  });
  const duplicate = insertCloudCopy(db, {
    client_note_id: "duplicate",
    cloud_id: "cloud-1",
    cloud_revision: 1,
    calendar_event_id: "",
    sync_status: "pending",
  });
  const snapshot = db.getNote(current);

  assert.deepEqual(db.mergeDuplicateCloudNotes(), [duplicate]);
  assert.deepEqual(db.getNote(current), snapshot, "the preferred dirty copy keeps its own base");
  assert.deepEqual(
    copiesOf(db, "cloud-1").map((note) => note.id),
    [current]
  );
  const recovered = db.getNote(alternate);
  assert.equal(recovered.cloud_id, null);
  assert.equal(recovered.cloud_revision, null);
  assert.equal(recovered.calendar_event_id, "");
  assert.equal(recovered.sync_status, "pending");
  assert.notEqual(recovered.client_note_id, "alternate");
  assert.equal(noteCount(db), 2);
});

for (const refresh of [false, true]) {
  test(`merged pending metadata ${refresh ? "refreshes once before" : "leaves no ghost after"} a cloud delete`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    const { readNoteConflicts } = require("../../src/lib/noteConflictRegistry.ts");
    const { clearNoteConflict } = require("../../src/stores/noteStore.ts");
    cloud.setClock(() => "2026-10-28T00:00:00.000Z");
    const row = cloud.seedNote({
      client_note_id: "cloud-key",
      title: "Copy",
      content: "body",
      calendar_event_id: "event",
    });
    cloud.setNoteRevision(row.id, 3);
    const remote = cloud.note(row.id);
    // Copies of a legacy shared private note, the one private note that syncs.
    const clean = db.upsertNoteFromCloud(remote, null);
    updateNote(db, clean.id, { is_shared: 1 });
    const pending = insertCloudCopy(db, {
      client_note_id: "pending-copy",
      cloud_id: row.id,
      cloud_revision: 2,
      cloud_updated_at: "2026-10-27T00:00:00.000Z",
      calendar_event_id: "event",
      is_shared: 1,
    });
    assert.equal(db.updateNote(pending, { calendar_event_id: "" }).success, true);
    const request = api.cloudApiRequest;
    let patches = 0;
    api.cloudApiRequest = async (options) => {
      if (options.method === "PATCH" && options.path === "/api/notes/update") {
        patches++;
        assert.equal(options.body.base_revision, 2, "never borrow the clean sibling's base");
        return {
          success: false,
          status: 409,
          code: "note_version_conflict",
          error: "stale revision",
          details: { note: remote },
        };
      }
      return request(options);
    };

    db.mergeDuplicateCloudNotes();
    await service.pushPendingNotes(false);
    assert.equal(patches, 1);
    assert.ok(readNoteConflicts()["pending-copy"]);
    if (refresh) {
      const note = db.getNote(pending);
      const fresh = await api.upsertNoteFromCloud(
        readNoteConflicts()["pending-copy"],
        note.folder_id,
        note.space_id
      );
      clearNoteConflict(note.client_note_id);
      if (fresh) clearNoteConflict(fresh.client_note_id);
      assert.equal(fresh.id, pending, "Refresh must settle the copy that conflicted");
      assert.equal(fresh.sync_status, "synced");
      await service.pushPendingNotes(false);
      assert.equal(patches, 1, "Refresh must not repeat the same conflict");
    }

    localStorageStub.setItem("lastSyncedAt.notes", "2026-10-28T12:00:00.000Z");
    cloud.setClock(() => "2026-10-29T00:00:00.000Z");
    await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
    await service.pullNotes(false);
    assert.equal(copiesOf(db, row.id).length, 0);
    assert.equal(noteCount(db), 0, "the original cloud note has no remaining ghost");
  });
}

test("a queued delete of one copy no longer deletes the note everywhere", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "body" });
  await service.syncAll(true);
  insertCloudCopy(db, {
    client_note_id: "stale-copy",
    cloud_id: row.id,
    space_id: ctx.team.id,
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

test("unpushed text that differs is kept as a note of its own on this device", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  // A private note backed up before Private stayed on the device.
  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "cloud" });
  const keyed = db.upsertNoteFromCloud(row, null, db.getPrivateSpaceId());
  updateNote(db, keyed.id, { sync_status: "pending", updated_at: LOCAL_LATE });
  // These are text-only edits, so keep the pulled copy's resolved default folder.
  const other = insertCloudCopy(db, {
    client_note_id: "edited-copy",
    cloud_id: row.id,
    folder_id: keyed.folder_id,
    title: "Keyed",
    content: "only here",
    sync_status: "pending",
    cloud_create_attempted: 1,
  });
  // A difference only in surrounding blanks isn't an edit.
  insertCloudCopy(db, {
    client_note_id: "same-copy",
    cloud_id: row.id,
    folder_id: keyed.folder_id,
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
  assert.equal(detached.cloud_id, null, "a private note never uploads (D2)");
  assert.notEqual(detached.client_note_id, "edited-copy", "it has an identity of its own");
  assert.equal(detached.content, "only here");
  assert.equal(detached.sync_status, "pending");
  assert.deepEqual(noteAndFolderWrites(cloud), []);
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
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Keyed", content: "fresh" });
  insertCloudCopy(db, {
    client_note_id: "local-key",
    cloud_id: row.id,
    space_id: ctx.team.id,
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
function syncedPastTheFeed(service, cloud) {
  localStorageStub.setItem("lastSyncedAt.notes", "2026-10-30T00:00:00.000Z");
  localStorageStub.removeItem("noteFeedReplay.v1");
  service.noteFeedReplayTried.clear();
  return cloud.log.length;
}

test("replaying the feed once retires a copy whose delete the cursor had passed", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  cloud.setClock(() => "2026-10-28T00:00:00.000Z");
  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Gone", content: "body" });
  await service.syncAll(true);
  updateNote(db, copiesOf(db, row.id)[0].id, { client_note_id: "local-key" });
  cloud.setClock(() => "2026-10-29T00:00:00.000Z");
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
  const mark = syncedPastTheFeed(service, cloud);
  assert.equal(noteCount(db), 1, "the ghost is there before the replay");

  await service.syncAll(true);

  assert.equal(noteCount(db), 0);
  const replays = () =>
    cloud.log
      .slice(mark)
      .filter((call) => call.path.startsWith("/api/notes/list") && call.path.includes("1970-01-01"))
      .length;
  assert.equal(replays(), 1);

  const fresh = new SyncService();
  t.after(() => stopSyncTimers(fresh));
  await fresh.syncAll(true);
  assert.equal(replays(), 1, "once per install, not per session");
});

test("the replay leaves a copy with unpushed text to its push", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  cloud.setClock(() => "2026-10-28T00:00:00.000Z");
  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Gone", content: "body" });
  await service.syncAll(true);
  const [copy] = copiesOf(db, row.id);
  updateNote(db, copy.id, { client_note_id: "local-key" });
  cloud.setClock(() => "2026-10-29T00:00:00.000Z");
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
  syncedPastTheFeed(service, cloud);
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
  syncedPastTheFeed(service, cloud);

  await service.syncAll(true);

  assert.ok(db.getNote(absent));
});

test("a failed replay is retried next session, and stops after a few attempts", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  cloud.setClock(() => "2026-10-28T00:00:00.000Z");
  const row = cloud.seedNote({ client_note_id: "cloud-key", title: "Gone", content: "body" });
  await service.syncAll(true);
  updateNote(db, copiesOf(db, row.id)[0].id, { client_note_id: "local-key" });
  cloud.setClock(() => "2026-10-29T00:00:00.000Z");
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
  const mark = syncedPastTheFeed(service, cloud);
  const isReplay = (call) =>
    call.path.startsWith("/api/notes/list") && call.path.includes("1970-01-01");
  const replays = () => cloud.log.slice(mark).filter(isReplay).length;
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

test("a first sync covers the feed without a second full read", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, service } = ctx;

  cloud.seedNote({ client_note_id: "live", title: "Live", content: "body" });
  await service.syncAll(true);

  assert.equal(localStorageStub.getItem("noteFeedReplay.v1"), "3");
  const lists = cloud.logFor("/api/notes/list");
  assert.equal(lists.length, 1, "a clean first sync traverses the feed only once");
  assert.equal(queryParam(lists[0].path, "since"), "1970-01-01T00:00:00.000Z");
});

test("a retry of a partial first pull removes old tombstones", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);
  t.mock.method(console, "warn", () => {});
  cloud.setClock(() => "2026-10-28T00:00:00.000Z");
  const folder = cloud.seedFolder({ client_folder_id: "later-folder", name: "Later" });
  const saved = cloud.seedUnkeyedNote({ title: "Saved before the failure", content: "body" });
  const parked = cloud.seedNote({
    client_note_id: "parked",
    title: "Waiting for its folder",
    content: "body",
    folder_id: folder.id,
  });
  cloud.failWith("GET /api/folders/list", { status: 503 });

  await service.syncAll(true);

  assert.equal(copiesOf(db, saved.id).length, 1);
  assert.equal(copiesOf(db, parked.id).length, 0);
  assert.equal(localStorageStub.getItem("lastSyncedAt.notes"), null);
  cloud.clearFailures();
  cloud.setClock(() => "2026-10-29T00:00:00.000Z");
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: saved.id } });
  const mark = cloud.log.length;

  await service.syncAll(true);

  assert.equal(copiesOf(db, saved.id).length, 0, "the retry must see the retained tombstone");
  assert.equal(copiesOf(db, parked.id).length, 1);
  assert.equal(localStorageStub.getItem("noteFeedReplay.v1"), "3");
  const lists = cloud.log.slice(mark).filter((call) => call.path.startsWith("/api/notes/list"));
  assert.equal(lists.length, 1, "the successful retry needs only one full traversal");
});

test("a first feed pull preserves unpushed text behind an old tombstone", async (t) => {
  const ctx = await setup(t, { team: true });
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);
  cloud.setClock(() => "2026-10-28T00:00:00.000Z");
  const row = cloud.seedUnkeyedNote({ title: "Edited offline", content: "old text" });
  const local = db.upsertNoteFromCloud(row, null, ctx.team.id);
  db.updateNote(local.id, { content: "unpushed text" });
  cloud.setClock(() => "2026-10-29T00:00:00.000Z");
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });

  await service.syncAll(true);

  assert.equal(db.getNote(local.id).content, "unpushed text");
  assert.equal(db.getNote(local.id).sync_status, "error", "the failed push remains retryable");
  assert.ok(localStorageStub.getItem("lastSyncedAt.notes"));
});

for (const backup of [true, false]) {
  test(`${backup ? "full" : "team-only"} replay waits for team capability without spending attempts`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    silenceConsoleErrors(t);
    localStorageStub.setItem("cloudBackupEnabled", String(backup));
    db.setActiveAccountId("user-harness");
    const space = {
      id: "cloud-space",
      workspace_id: "workspace",
      name: "Team",
      slug: "team",
      description: null,
      emoji: null,
      my_role: "admin",
      my_direct_role: "admin",
      member_count: 1,
      teams: [],
      created_at: "2026-10-28T00:00:00.000Z",
      updated_at: "2026-10-28T00:00:00.000Z",
    };
    const localSpace = db.upsertSpaceFromCloud(space);
    db.setSpaceSyncStatus(localSpace.id, "synced");
    cloud.setClock(() => "2026-10-28T00:00:00.000Z");
    const row = cloud.seedUnkeyedNote({ title: "Old team copy", content: "body" });
    cloud.setNoteRevision(row.id, 1);
    const local = db.upsertNoteFromCloud(
      { ...row, space_id: space.id, user_id: "user-harness", revision: 1 },
      null,
      localSpace.id
    );
    cloud.setClock(() => "2026-10-29T00:00:00.000Z");
    await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
    localStorageStub.setItem("lastSyncedAt.notes", "2026-10-30T00:00:00.000Z");
    localStorageStub.setItem("lastSyncedAt.notes.team", "2026-10-30T00:00:00.000Z");
    cloud.setClock(() => "2026-11-01T00:00:00.000Z");
    const personal = cloud.seedNote({ client_note_id: "personal-delta", title: "Personal" });

    let available = false;
    const request = api.cloudApiRequest;
    api.cloudApiRequest = async (opts) => {
      const response = await request(opts);
      if (opts.path === "/api/me/spaces" && available) {
        return { success: true, data: { data: [space] } };
      }
      if (opts.path.startsWith("/api/notes/list") && response.success) {
        return {
          ...response,
          data: {
            notes: response.data.notes
              .filter((note) => note.id !== row.id || queryParam(opts.path, "scope") === "all")
              .map((note) =>
                note.id === row.id ? { ...note, space_id: space.id, user_id: "user-harness" } : note
              ),
          },
        };
      }
      return response;
    };

    const replayKey = backup ? "noteFeedReplay.v1" : "noteFeedReplay.v1.team";
    for (let attempt = 0; attempt < 4; attempt++) {
      const session = attempt === 0 ? service : new SyncService();
      t.after(() => stopSyncTimers(session));
      await session.syncAll(true);
    }

    assert.ok(db.getNote(local.id), "personal scope cannot see the old team tombstone");
    assert.equal(localStorageStub.getItem(replayKey), null, "incomplete scope spends no attempts");
    assert.equal(copiesOf(db, personal.id).length, 0, "a personal row stays in the cloud (D2)");
    available = true;

    await service.syncAll(true);

    assert.equal(db.getNote(local.id), null, "capability recovery must replay the old tombstone");
    assert.equal(localStorageStub.getItem(replayKey), "3");
    const replays = () =>
      cloud.logFor("/api/notes/list").filter((call) => call.path.includes("1970-01-01"));
    assert.equal(replays().length, 1);
    assert.equal(queryParam(replays()[0].path, "scope"), "all");
    await service.syncAll(true);
    assert.equal(replays().length, 1, "a completed repair is not repeated");
  });
}

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

// --- Private notes stay on the device (D2) -----------------------------------

const PRIVATE_ACCOUNT = "user-harness";
const NOTE_AND_FOLDER_WRITES = new Set([
  "POST /api/notes/create",
  "POST /api/notes/batch-create",
  "PATCH /api/notes/update",
  "POST /api/folders/create",
  "POST /api/folders/batch-create",
  "PATCH /api/folders/update",
]);

function noteAndFolderWrites(cloud) {
  return cloud.log.filter((call) =>
    NOTE_AND_FOLDER_WRITES.has(`${call.method} ${call.path.split("?")[0]}`)
  );
}

// Signed in, as useAuth and the workspace bridge leave main: the active
// workspace isn't the default one, so the active Private and the default's are
// two rows and a test can tell which one sync used.
async function setupSignedIn(t, { backup = true } = {}) {
  const ctx = await setup(t);
  if (!ctx) return null;
  ctx.db.setActiveAccountId(PRIVATE_ACCOUNT);
  ctx.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-active",
    defaultWorkspaceId: "workspace-default",
  });
  localStorageStub.setItem("cloudBackupEnabled", String(backup));
  ctx.activePrivateId = ctx.db.getPrivateSpaceId();
  ctx.defaultPrivateId = ctx.db.getDefaultPrivateSpaceId();
  assert.notEqual(ctx.activePrivateId, ctx.defaultPrivateId);
  return ctx;
}

// A private note with a cloud copy from before Private stayed on the device: as
// Backup or an earlier share left it.
function linkPrivateNote(db, cloud, spaceId, fields = {}) {
  const row = cloud.seedNote({
    title: "Private",
    content: "cloud body",
    created_at: "2026-07-20T09:00:00.000Z",
    updated_at: "2026-07-20T09:00:00.000Z",
    ...fields,
  });
  const local = db.upsertNoteFromCloud(row, null, spaceId);
  return { row, local };
}

test("a full pass with Backup on uploads no private note or folder", async (t) => {
  const ctx = await setupSignedIn(t);
  if (!ctx) return;
  const { db, cloud, service, activePrivateId, defaultPrivateId } = ctx;

  const folder = db.createFolder("Ideas", activePrivateId).folder;
  const fresh = db.saveNote("Draft", "never leaves", "personal", null, null, folder.id).note;
  const inDefault = db.saveNote(
    "Default",
    "never leaves either",
    "personal",
    null,
    null,
    null,
    defaultPrivateId
  ).note;
  // Backed up before this change, then edited: its cloud copy must not move.
  const { row, local: backedUp } = linkPrivateNote(db, cloud, activePrivateId);
  db.updateNote(backedUp.id, { content: "edited since" });
  // A folder linked to a cloud folder, then renamed.
  const cloudFolder = cloud.seedFolder({ name: "Old name", client_folder_id: "linked-folder" });
  const linkedFolder = db.createFolder("Linked", activePrivateId).folder;
  db.db
    .prepare(
      "UPDATE folders SET client_folder_id = ?, cloud_id = ?, sync_status = 'pending' WHERE id = ?"
    )
    .run("linked-folder", cloudFolder.id, linkedFolder.id);

  await service.syncAll(true);
  // The debounced pushes an edit or a rename starts.
  await service.pushEntity("note", backedUp.id);
  await service.pushEntity("note", fresh.id);
  await service.pushEntity("folder", folder.id);
  await service.pushEntity("folder", linkedFolder.id);

  assert.deepEqual(noteAndFolderWrites(cloud), [], "no private note or folder was sent");
  assert.equal(cloud.notes().length, 1, "only the copy that already existed");
  assert.equal(cloud.note(row.id).content, "cloud body", "the old cloud copy is untouched");
  assert.equal(cloud.folder(cloudFolder.id).name, "Old name");
  for (const note of [fresh, inDefault, backedUp]) {
    assert.equal(db.getNote(note.id).sync_status, "pending", "left as it was, not marked");
  }
  assert.equal(db.getNote(backedUp.id).content, "edited since");
  assert.equal(db.getNote(fresh.id).cloud_id, null);
});

test("a shared private note still pushes edits, without its private folder", async (t) => {
  for (const backup of [true, false]) {
    await t.test(backup ? "Backup on" : "Backup off", async (st) => {
      const ctx = await setupSignedIn(st, { backup });
      if (!ctx) return;
      const { db, cloud, service, activePrivateId } = ctx;
      const cloudFolder = cloud.seedFolder({ name: "Ideas", client_folder_id: "ideas" });
      const folder = db.createFolder("Ideas", activePrivateId).folder;
      db.db
        .prepare("UPDATE folders SET client_folder_id = 'ideas', cloud_id = ? WHERE id = ?")
        .run(cloudFolder.id, folder.id);
      const { row, local } = linkPrivateNote(db, cloud, activePrivateId, {
        folder_id: cloudFolder.id,
      });
      db.updateNote(local.id, { folder_id: folder.id });
      db.updateNoteShareState(local.id, { is_shared: 1 });
      // The server still takes a shared note's edits once the account is on
      // device-only.
      cloud.shareNote(row.id);
      cloud.switchOnDevice();

      db.updateNote(local.id, { content: "an edit the guests should see" });
      if (backup) await service.syncAll(true);
      else await service.pushEntity("note", local.id);

      const patches = cloud.logFor("/api/notes/update");
      assert.equal(patches.length, 1);
      assert.equal(patches[0].body.id, row.id);
      assert.equal(patches[0].body.content, "an edit the guests should see");
      assert.equal(patches[0].body.folder_id, null, "private folders never reach the cloud");
      assert.equal(cloud.note(row.id).content, "an edit the guests should see");
      const after = db.getNote(local.id);
      assert.equal(after.sync_status, "synced");
      assert.equal(after.space_id, activePrivateId);
      assert.equal(after.folder_id, folder.id, "the note stays filed here");
      assert.equal(cloud.logFor("/api/folders/update").length, 0);
    });
  }
});

test("a pull with a personal row for an unshared note changes nothing locally", async (t) => {
  for (const backup of [true, false]) {
    await t.test(backup ? "Backup on" : "Backup off", async (st) => {
      const ctx = await setupSignedIn(st, { backup });
      if (!ctx) return;
      const { db, cloud, service, activePrivateId, defaultPrivateId } = ctx;
      const edited = linkPrivateNote(db, cloud, activePrivateId, { content: "kept here" });
      const deleted = linkPrivateNote(db, cloud, defaultPrivateId, { content: "still here" });
      const cloudFolder = cloud.seedFolder({ name: "Ideas", client_folder_id: "ideas" });
      const folder = db.createFolder("Ideas", activePrivateId).folder;
      db.db
        .prepare(
          "UPDATE folders SET client_folder_id = 'ideas', cloud_id = ?, sync_status = 'synced' WHERE id = ?"
        )
        .run(cloudFolder.id, folder.id);
      // Another device, or the 30-day grace, still writes personal rows.
      await editInCloud(cloud, edited.row.id, {
        content: "changed elsewhere",
        updated_at: "2026-07-21T00:00:00.000Z",
      });
      await cloud.request({
        method: "DELETE",
        path: "/api/notes/delete",
        body: { id: deleted.row.id },
      });
      cloud.seedNote({ client_note_id: "cloud-only", title: "From the cloud" });
      await cloud.request({
        method: "PATCH",
        path: "/api/folders/update",
        body: { id: cloudFolder.id, name: "Renamed elsewhere" },
      });
      cloud.seedFolder({ name: "Cloud folder", client_folder_id: "cloud-only-folder" });
      const before = snapshotNotes(db);
      const folders = db.db.prepare("SELECT * FROM folders ORDER BY id").all();

      await service.syncAll(true);
      // A snapshot pull, as a denial or backfill runs, ignores them too.
      await service.pullNotes(!backup, true);
      await service.pullFolders(!backup, true);

      assert.deepEqual(
        snapshotNotes(db),
        before,
        "no private note was created, changed or deleted"
      );
      assert.deepEqual(db.db.prepare("SELECT * FROM folders ORDER BY id").all(), folders);
      assert.equal(db.getNoteByClientId("cloud-only"), null);
      assert.equal(db.getNote(edited.local.id).content, "kept here");
      assert.ok(db.getNote(deleted.local.id), "a personal tombstone deletes nothing");
    });
  }
});

test("a guest's edit to a shared private note pulls in where the note is filed", async (t) => {
  for (const backup of [true, false]) {
    await t.test(backup ? "Backup on" : "Backup off", async (st) => {
      const ctx = await setupSignedIn(st, { backup });
      if (!ctx) return;
      const { db, cloud, service, activePrivateId } = ctx;
      const folder = db.createFolder("Shared things", activePrivateId).folder;
      const { row, local } = linkPrivateNote(db, cloud, activePrivateId);
      // Filed and shared on this device before the guest's edit.
      updateNote(db, local.id, { folder_id: folder.id, is_shared: 1 });
      cloud.shareNote(row.id);
      cloud.switchOnDevice();
      await editInCloud(cloud, row.id, {
        content: "a guest's edit",
        updated_at: "2026-07-21T00:00:00.000Z",
      });

      await service.syncAll(true);

      const after = db.getNote(local.id);
      assert.equal(after.content, "a guest's edit");
      assert.equal(after.space_id, activePrivateId, "it stays in its own Private");
      assert.equal(after.folder_id, folder.id, "and in its folder");
      assert.equal(after.sync_status, "synced");
      assert.equal(after.is_shared, 1);

      await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: row.id } });
      await service.syncAll(true);
      assert.equal(db.getNote(local.id), null, "the owner's delete elsewhere applies too");
    });
  }
});

test("a revoked team note forks into that workspace's Private", async (t) => {
  const ctx = await setupSignedIn(t);
  if (!ctx) return;
  const { db, cloud, api, service, activePrivateId, defaultPrivateId } = ctx;
  silenceConsoleErrors(t);
  const team = joinTeamSpace(db, cloud, { fileRowsHere: false });
  const row = cloud.seedNote({
    title: "Team draft",
    content: "team body",
    space_id: TEAM_SPACE.id,
    workspace_id: TEAM_SPACE.workspace_id,
    user_id: PRIVATE_ACCOUNT,
  });
  const local = db.upsertNoteFromCloud(row, null, team.id);
  db.updateNote(local.id, { content: "unpushed edit" });
  cloud.failNext("PATCH /api/notes/update", { status: 403, code: "space_access_revoked" });

  await service.syncAll(true);

  const forked = db.getNote(local.id);
  const workspacePrivateId = db.getPrivateSpaceId(TEAM_SPACE.workspace_id);
  assert.equal(forked.space_id, workspacePrivateId);
  assert.notEqual(workspacePrivateId, activePrivateId);
  assert.notEqual(workspacePrivateId, defaultPrivateId);
  assert.equal(db.getSpace(workspacePrivateId).kind, "private");
  assert.equal(forked.content, "unpushed edit", "the edit survives");
  assert.equal(forked.cloud_id, null);
  assert.notEqual(forked.client_note_id, row.client_note_id);
  assert.deepEqual(
    api.syncEvents.filter((event) => event.name === "note-relocated").map((e) => e.payload.title),
    ["Team draft"]
  );
  const mark = cloud.log.length;
  await service.syncAll(true);
  assert.deepEqual(
    noteAndFolderWrites({ log: cloud.log.slice(mark) }),
    [],
    "the fork stays private"
  );
});

test("a team note's access stub forks a dirty copy into that workspace's Private", async (t) => {
  const ctx = await setupSignedIn(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const team = joinTeamSpace(db, cloud, { fileRowsHere: false });
  const row = cloud.seedNote({
    title: "Moved away",
    content: "team body",
    space_id: TEAM_SPACE.id,
    workspace_id: TEAM_SPACE.workspace_id,
    user_id: PRIVATE_ACCOUNT,
  });
  const local = db.upsertNoteFromCloud(row, null, team.id);
  db.updateNote(local.id, { content: "unpushed edit" });
  // A private note that happens to match the stub is this device's own.
  const own = linkPrivateNote(db, cloud, ctx.activePrivateId);
  const send = api.cloudApiRequest;
  api.cloudApiRequest = async (opts) => {
    if (opts.method === "PATCH") return { success: false, status: 500, error: "offline" };
    const answer = await send(opts);
    if (!opts.path.startsWith("/api/notes/list") || !answer.success) return answer;
    const stub = (note) => ({
      id: note.id,
      client_note_id: note.client_note_id,
      space_id: null,
      previous_space_id: note.space_id ?? null,
      access_removed: true,
      updated_at: "2026-07-22T00:00:00.000Z",
    });
    return {
      ...answer,
      data: {
        notes: answer.data.notes.map((note) =>
          note.id === row.id || note.id === own.row.id ? stub(note) : note
        ),
      },
    };
  };
  silenceConsoleErrors(t);

  await service.syncAll(true);

  const forked = db.getNote(local.id);
  assert.equal(forked.space_id, db.getPrivateSpaceId(TEAM_SPACE.workspace_id));
  assert.equal(forked.content, "unpushed edit");
  assert.equal(forked.cloud_id, null);
  const ownAfter = db.db.prepare("SELECT * FROM notes WHERE id = ?").get(own.local.id);
  assert.deepEqual(ownAfter, own.local, "a private note ignores the stub");
});

test("a personal row turns a team copy private in the default's Private, not the active one", async (t) => {
  for (const backup of [true, false]) {
    await t.test(backup ? "Backup on" : "Backup off", async (st) => {
      const ctx = await setupSignedIn(st, { backup });
      if (!ctx) return;
      const { db, cloud, service, defaultPrivateId } = ctx;
      const team = joinTeamSpace(db, cloud, { fileRowsHere: false });
      const row = cloud.seedNote({
        title: "Was the team's",
        content: "team body",
        space_id: TEAM_SPACE.id,
        workspace_id: TEAM_SPACE.workspace_id,
        user_id: PRIVATE_ACCOUNT,
        updated_at: "2026-07-20T09:00:00.000Z",
      });
      const local = db.upsertNoteFromCloud(row, null, team.id);
      // An older build moved it out of the team.
      await editInCloud(cloud, row.id, {
        space_id: null,
        workspace_id: null,
        content: "now personal",
        updated_at: "2026-07-21T00:00:00.000Z",
      });

      await service.syncAll(true);

      const after = db.getNote(local.id);
      assert.equal(after.space_id, defaultPrivateId);
      assert.equal(after.content, "now personal");
    });
  }
});

test("a batch create the server refuses stays pending, unforked and unmarked", async (t) => {
  const ctx = await setupSignedIn(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const team = joinTeamSpace(db, cloud);
  const accepted = saveNoteIn(db, team.id, "Accepted", "body").note;
  const refused = saveNoteIn(db, team.id, "Refused", "body").note;
  // A racing build's write the server refuses: it answers for the rest.
  const send = api.cloudApiRequest;
  api.cloudApiRequest = async (opts) => {
    if (opts.path !== "/api/notes/batch-create") return send(opts);
    const answer = await send({
      ...opts,
      body: { notes: opts.body.notes.filter((n) => n.client_note_id !== refused.client_note_id) },
    });
    return {
      ...answer,
      data: {
        ...answer.data,
        refused: [{ client_note_id: refused.client_note_id, code: "personal_notes_on_device" }],
      },
    };
  };

  await service.syncAll(true);

  assert.equal(db.getNote(accepted.id).sync_status, "synced");
  const left = db.getNote(refused.id);
  assert.equal(left.sync_status, "pending");
  assert.equal(left.cloud_id, null);
  assert.equal(left.client_note_id, refused.client_note_id, "not forked");
  assert.equal(left.space_id, team.id);
  assert.equal(cloud.logFor("/api/notes/batch-create").length, 1);
  assert.equal(cloud.logFor("/api/notes/create").length, 0, "no retry in the same pass");
});

test("a folder batch the server partly refuses links the rest by position", async (t) => {
  const ctx = await setupSignedIn(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const team = joinTeamSpace(db, cloud);
  const first = db.createFolder("First", team.id).folder;
  const refused = db.createFolder("Refused", team.id).folder;
  const last = db.createFolder("Last", team.id).folder;
  const send = api.cloudApiRequest;
  api.cloudApiRequest = async (opts) => {
    if (opts.path !== "/api/folders/batch-create") return send(opts);
    const answer = await send({
      ...opts,
      body: {
        folders: opts.body.folders.filter((f) => f.client_folder_id !== refused.client_folder_id),
      },
    });
    return {
      ...answer,
      data: {
        ...answer.data,
        refused: [{ client_folder_id: refused.client_folder_id, code: "personal_notes_on_device" }],
      },
    };
  };

  await service.syncAll(true);

  assert.equal(
    db.getFolderByClientId(first.client_folder_id).cloud_id,
    cloud.folder(first.client_folder_id).id
  );
  assert.equal(
    db.getFolderByClientId(last.client_folder_id).cloud_id,
    cloud.folder(last.client_folder_id).id
  );
  const left = db.getFolderByClientId(refused.client_folder_id);
  assert.equal(left.cloud_id, null);
  assert.equal(left.sync_status, "pending");
});

test("a share ended on another device stops the note's pushes after one refusal", async (t) => {
  for (const first of ["full pass", "debounced push"]) {
    await t.test(`found by a ${first}`, async (st) => {
      const ctx = await setupSignedIn(st);
      if (!ctx) return;
      const { db, cloud, service, activePrivateId } = ctx;
      const errors = silenceConsoleErrors(st);
      const { row, local } = linkPrivateNote(db, cloud, activePrivateId);
      db.updateNoteShareState(local.id, { is_shared: 1, share_token: "ow_share_stale" });
      // Unshared or revoked elsewhere: the server no longer counts it as shared,
      // and nothing this device pulls says so.
      cloud.switchOnDevice();
      db.updateNote(local.id, { content: "edit" });

      if (first === "full pass") await service.syncAll(true);
      else await service.pushEntity("note", local.id);

      assert.equal(cloud.logFor("/api/notes/update").length, 1, "one refused attempt");
      const after = db.getNote(local.id);
      assert.equal(after.is_shared, 0, "the refusal ends this device's share");
      assert.equal(after.share_token, null);
      assert.equal(after.sync_status, "pending", "not marked error");
      assert.equal(after.cloud_id, row.id, "not forked");
      assert.equal(after.client_note_id, local.client_note_id);

      // Now an ordinary private note: no edit or pass sends it again.
      db.updateNote(local.id, { content: "a later edit" });
      await service.pushEntity("note", local.id);
      await service.syncAll(true);
      assert.equal(cloud.logFor("/api/notes/update").length, 1);
      assert.equal(cloud.note(row.id).content, "cloud body");
      assert.equal(db.getNote(local.id).content, "a later edit");
      assert.deepEqual(
        errorMessages(errors).filter((message) => /note/i.test(message)),
        [],
        "nothing about it is logged as a failure"
      );
    });
  }
});

test("a note that left a team before this change is cut loose, not retracted", async (t) => {
  const ctx = await setupSignedIn(t);
  if (!ctx) return;
  const { db, cloud, service, activePrivateId } = ctx;
  const team = joinTeamSpace(db, cloud, { fileRowsHere: false });
  const row = cloud.seedNote({
    title: "Taken out",
    content: "team body",
    space_id: TEAM_SPACE.id,
    workspace_id: TEAM_SPACE.workspace_id,
    user_id: PRIVATE_ACCOUNT,
  });
  const local = db.upsertNoteFromCloud(row, null, team.id);
  // How an older build left a team → Private move whose retraction never landed.
  db.db
    .prepare(
      "UPDATE notes SET space_id = ?, folder_id = NULL, left_team = 1, sync_status = 'pending', content = 'private edit' WHERE id = ?"
    )
    .run(activePrivateId, local.id);

  await service.syncAll(true);

  assert.deepEqual(noteAndFolderWrites(cloud), [], "nothing is retracted or uploaded");
  assert.equal(cloud.note(row.id).space_id, TEAM_SPACE.id, "the team keeps its copy");
  const after = db.getNote(local.id);
  assert.equal(after.space_id, activePrivateId);
  assert.equal(after.content, "private edit");
  assert.equal(after.cloud_id, null);
  assert.equal(after.left_team, 0);
  assert.notEqual(after.client_note_id, row.client_note_id);
});

test("the upload queues hold teamspace rows and legacy shared private notes only", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = joinTeamSpace(db, null);
  const teamNote = saveNoteIn(db, team.id, "Team", "body").note;
  const privateNote = db.saveNote("Private", "body").note;
  const shared = db.saveNote("Shared earlier", "body").note;
  updateNote(db, shared.id, { cloud_id: "cloud-shared", is_shared: 1, sync_status: "pending" });
  const forked = db.saveNote("Shared, then forked", "body").note;
  updateNote(db, forked.id, { is_shared: 1, sync_status: "pending" });
  const teamFolder = db.createFolder("Team folder", team.id).folder;
  db.createFolder("Private folder");

  const ids = (rows) => rows.map((row) => row.id).sort((a, b) => a - b);
  assert.deepEqual(ids(db.getPendingNotes("team")), [teamNote.id]);
  assert.deepEqual(ids(db.getPendingNotes("syncable")), [teamNote.id, shared.id]);
  assert.ok(
    db.getPendingNotes().some((note) => note.id === privateNote.id),
    "still queued locally"
  );
  assert.ok(!db.getPendingNotes("syncable").some((note) => note.id === forked.id));
  assert.deepEqual(ids(db.getPendingFolders("team")), [teamFolder.id]);
});

test("merging legacy share metadata does not upload unchanged content", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const remote = cloud.seedNote({ client_note_id: "share-key", title: "Copy", content: "body" });
  const clean = db.upsertNoteFromCloud(remote, null);
  insertCloudCopy(db, {
    client_note_id: "share-copy",
    cloud_id: remote.id,
    is_shared: 1,
    share_token: "legacy-token",
    cloud_updated_at: "2020-01-01T00:00:00Z",
  });
  db.mergeDuplicateCloudNotes();
  assert.equal(db.getNote(clean.id).sync_status, "synced");
  const before = cloud.log.length;
  await service.pushPendingNotes(false);
  assert.equal(
    cloud.log
      .slice(before)
      .filter((call) => call.method === "PATCH" && call.path === "/api/notes/update").length,
    0
  );
});
