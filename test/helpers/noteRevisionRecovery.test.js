const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  establishValidatedAuth,
  enableSync,
  stopSyncTimers,
  localStorage: localStorageStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { readNoteConflicts } = require("../../src/lib/noteConflictRegistry.ts");

const INITIAL = {
  id: "cloud-note",
  client_note_id: "client-note",
  title: "Meeting",
  content: "Personal notes",
  enhanced_content: "Summary",
  enhancement_prompt: "Summarize",
  enhancement_template_id: "template",
  enhanced_at_content_hash: "hash",
  transcript: "Original transcript",
  note_type: "meeting",
  folder_id: null,
  space_id: null,
  user_id: "user-harness",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  revision: 7,
  content_state: null,
  enhanced_content_state: null,
};
const OTHER = { ...INITIAL, id: "cloud-other", client_note_id: "client-other" };
const copy = (value) => JSON.parse(JSON.stringify(value));

// HTTP alone is simulated. Every delta is quiet, so unchanged pre-revision
// rows can recover only through a full snapshot. Writes require explicit,
// revision-guarded clears; a legacy blank cannot make these tests converge.
function recoveryCloud({ notes = [INITIAL], failedSnapshots = 0, probeNote = notes[0] } = {}) {
  const rows = new Map(notes.map((note) => [note.id, copy(note)]));
  const calls = [];
  return {
    calls,
    row: (id = INITIAL.id) => copy(rows.get(id)),
    async request(opts) {
      calls.push(copy(opts));
      if (opts.path.startsWith("/api/notes/list")) {
        const query = new URLSearchParams(opts.path.split("?")[1]);
        if (query.get("limit") === "1")
          return { success: true, data: { notes: [copy(probeNote)] } };
        if (query.has("since")) return { success: true, data: { notes: [] } };
        if (failedSnapshots > 0) {
          failedSnapshots--;
          return { success: false, status: 503, error: "Snapshot temporarily unavailable" };
        }
        return { success: true, data: { notes: [...rows.values()].map(copy) } };
      }
      assert.equal(opts.path, "/api/notes/update", "unexpected HTTP request");
      const input = opts.body;
      const row = rows.get(input.id);
      if (input.base_revision !== row.revision)
        return { success: false, status: 409, code: "note_version_conflict" };
      const operations = Object.entries(input.field_updates ?? {});
      if (
        operations.length === 0 ||
        operations.some(
          ([field, operation]) =>
            !["content", "enhanced_content"].includes(field) ||
            operation !== "clear" ||
            input[field] !== ""
        )
      )
        return { success: false, status: 400, code: "validation_error" };
      for (const [field] of operations) {
        row[field] = field === "content" ? "" : null;
        row[`${field}_state`] = "clear";
        if (field === "enhanced_content") {
          row.enhancement_prompt = null;
          row.enhanced_at_content_hash = null;
        }
      }
      row.revision++;
      row.updated_at = new Date(Date.parse(row.updated_at) + 1).toISOString();
      return { success: true, data: copy(row) };
    },
  };
}

function listCalls(cloud, kind) {
  return cloud.calls.filter((call) => {
    if (!call.path.startsWith("/api/notes/list")) return false;
    const query = new URLSearchParams(call.path.split("?")[1]);
    if (kind === "probe") return query.get("limit") === "1";
    if (kind === "delta") return query.has("since");
    return query.get("limit") !== "1" && !query.has("since");
  });
}

const updateCalls = (cloud) => cloud.calls.filter((call) => call.path === "/api/notes/update");

function preRevisionNote(db, cloudNote = INITIAL) {
  const note = db.upsertNoteFromCloud(cloudNote, null);
  db.db.prepare("UPDATE notes SET cloud_revision = NULL WHERE id = ?").run(note.id);
  return db.getNote(note.id);
}

async function client(t, db, cloud) {
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  windowStub.electronAPI = createElectronApi(db, { cloud });
  await establishValidatedAuth();
  localStorageStub.setItem("lastSyncedAt.notes", "2026-06-01T00:00:00.000Z");
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return service;
}

function reopen(db) {
  const filename = db.db.name;
  db.db.close();
  db.db = new (require("better-sqlite3"))(filename);
}

function assertCleared(note, field) {
  assert.equal(note[field], field === "content" ? "" : null);
  assert.equal(note[`${field}_sync_operation`], null);
  assert.equal(note.cloud_revision, 8);
  assert.equal(note.sync_status, "synced");
  const untouched = field === "content" ? "enhanced_content" : "content";
  assert.equal(note[untouched], INITIAL[untouched]);
  assert.equal(note.transcript, INITIAL.transcript);
  assert.equal(note.enhancement_template_id, INITIAL.enhancement_template_id);
  assert.equal(note.enhancement_prompt, field === "content" ? INITIAL.enhancement_prompt : null);
  assert.equal(
    note.enhanced_at_content_hash,
    field === "content" ? INITIAL.enhanced_at_content_hash : null
  );
}

for (const field of ["content", "enhanced_content"]) {
  test(`${field}: a failed clear recovery retries on the next quiet sync pass`, async (t) => {
    const db = createDb(t);
    const secondDb = createDb(t);
    if (!db || !secondDb) return;
    const note = preRevisionNote(db);
    const secondNote = secondDb.upsertNoteFromCloud(INITIAL, null);
    db.updateNote(note.id, { clear_fields: [field] });
    const cloud = recoveryCloud({ failedSnapshots: 1 });
    const service = await client(t, db, cloud);
    const adoption = t.mock.method(windowStub.electronAPI, "setNoteCloudBase");

    await service.syncNotes();
    assert.equal(listCalls(cloud, "probe").length, 1);
    assert.equal(listCalls(cloud, "snapshot").length, 1);
    assert.equal(listCalls(cloud, "delta").length, 1);
    assert.equal(updateCalls(cloud).length, 0);
    assert.equal(db.getNote(note.id).cloud_revision, null);
    assert.equal(db.getNote(note.id).sync_status, "pending");
    assert.equal(db.getNote(note.id)[`${field}_sync_operation`], "clear");
    assert.equal(cloud.row()[field], INITIAL[field]);

    await service.syncNotes();
    assert.equal(listCalls(cloud, "snapshot").length, 2, "failed recovery must be retried");
    assert.deepEqual(adoption.mock.calls[0].arguments, [note.id, INITIAL.updated_at, 7]);
    assert.equal(updateCalls(cloud).length, 1);
    const [patch] = updateCalls(cloud);
    assert.equal(patch.method, "PATCH");
    assert.equal(patch.body.base_revision, 7);
    assert.deepEqual(patch.body.field_updates, { [field]: "clear" });
    assert.equal(cloud.row()[`${field}_state`], "clear");
    assert.equal(cloud.row()[field], field === "content" ? "" : null);
    reopen(db);
    assertCleared(db.getNote(note.id), field);

    await service.syncNotes();
    assert.equal(listCalls(cloud, "snapshot").length, 2);
    assert.equal(listCalls(cloud, "delta").length, 3);
    assert.equal(updateCalls(cloud).length, 1);
    const secondService = await client(t, secondDb, cloud);
    assert.equal(await secondService.pullNotes(false, true), true);
    reopen(secondDb);
    assertCleared(secondDb.getNote(secondNote.id), field);
  });
}

test("a clean pre-revision row retries a failed snapshot and receives a missed clear", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = preRevisionNote(db);
  const missing = preRevisionNote(db, OTHER);
  const cloud = recoveryCloud({
    notes: [{ ...INITIAL, revision: 8, content: "", content_state: "clear" }],
    failedSnapshots: 1,
  });
  const service = await client(t, db, cloud);

  await service.syncNotes();
  assert.equal(listCalls(cloud, "probe").length, 1);
  assert.equal(listCalls(cloud, "snapshot").length, 1);
  assert.equal(db.getNote(note.id).content, INITIAL.content);
  assert.equal(db.getNote(note.id).cloud_revision, null);
  assert.equal(db.getNote(note.id).sync_status, "synced");

  await service.syncNotes();
  assert.equal(listCalls(cloud, "snapshot").length, 2, "failed backfill must be retried");
  reopen(db);
  assertCleared(db.getNote(note.id), "content");
  assert.equal(db.getNote(missing.id).cloud_revision, null);
  assert.equal(db.countNotesMissingRevision(), 1);
  await service.syncNotes();
  assert.equal(listCalls(cloud, "snapshot").length, 2, "a completed snapshot stays bounded");
  assert.equal(listCalls(cloud, "delta").length, 3);
  assert.equal(updateCalls(cloud).length, 0);
});

test("repeated failures permit at most one snapshot per recovery path per ordinary pass", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const pending = preRevisionNote(db);
  const clean = preRevisionNote(db, OTHER);
  db.updateNote(pending.id, { clear_fields: ["content"] });
  const cloud = recoveryCloud({ notes: [INITIAL, OTHER], failedSnapshots: 6 });
  const service = await client(t, db, cloud);
  const requestPass = t.mock.method(service, "requestSyncAll", () => {});

  for (let pass = 1; pass <= 3; pass++) {
    await service.syncNotes();
    assert.equal(listCalls(cloud, "snapshot").length, pass * 2);
    assert.equal(listCalls(cloud, "delta").length, pass);
    assert.equal(updateCalls(cloud).length, 0);
    assert.equal(db.getNote(pending.id).sync_status, "pending");
    assert.equal(db.getNote(pending.id).content_sync_operation, "clear");
    assert.equal(db.getNote(pending.id).cloud_revision, null);
    assert.equal(db.getNote(clean.id).sync_status, "synced");
    assert.equal(db.getNote(clean.id).cloud_revision, null);
    assert.equal(cloud.row().content, INITIAL.content);
    assert.equal(requestPass.mock.callCount(), 0, "recovery must not schedule another pass");
  }
  await service.syncNotes();
  assert.equal(listCalls(cloud, "snapshot").length, 7);
  assert.equal(listCalls(cloud, "probe").length, 1);
  assert.equal(updateCalls(cloud).length, 1);
  assertCleared(db.getNote(pending.id), "content");
  assert.equal(db.getNote(clean.id).cloud_revision, 7);
  await service.syncNotes();
  assert.equal(listCalls(cloud, "snapshot").length, 7);
  assert.equal(requestPass.mock.callCount(), 0);
});

for (const empty of [false, true]) {
  test(`a completed ${empty ? "empty" : "unrelated-row"} snapshot does not repeatedly recover absent notes`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const pending = preRevisionNote(db);
    const clean = preRevisionNote(db, OTHER);
    db.updateNote(pending.id, { clear_fields: ["content"] });
    const unrelated = { ...INITIAL, id: "cloud-unrelated", client_note_id: "client-unrelated" };
    const cloud = recoveryCloud({ notes: empty ? [] : [unrelated], probeNote: unrelated });
    const service = await client(t, db, cloud);

    for (let pass = 0; pass < 3; pass++) await service.syncNotes();
    assert.equal(listCalls(cloud, "snapshot").length, 2, "one completed pull for each path");
    assert.equal(listCalls(cloud, "delta").length, 3);
    assert.equal(updateCalls(cloud).length, 0);
    assert.equal(db.getNote(pending.id).sync_status, "pending");
    assert.equal(db.getNote(pending.id).content_sync_operation, "clear");
    assert.equal(db.getNote(pending.id).cloud_revision, null);
    assert.equal(db.getNote(clean.id).cloud_revision, null);
    assert.equal(db.getNote(clean.id).content, INITIAL.content);
  });
}

test("a parked revision snapshot retries after the missing folder arrives", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = preRevisionNote(db);
  const cloud = recoveryCloud({
    notes: [
      { ...INITIAL, folder_id: "cloud-folder", revision: 8, content: "", content_state: "clear" },
    ],
  });
  const service = await client(t, db, cloud);

  await service.syncNotes();
  assert.equal(listCalls(cloud, "snapshot").length, 1);
  assert.equal(db.getNote(note.id).cloud_revision, null);
  assert.equal(db.getNote(note.id).content, INITIAL.content);
  assert.equal(db.getNote(note.id).folder_id, note.folder_id);
  const folder = db.upsertFolderFromCloud(
    {
      id: "cloud-folder",
      client_folder_id: "client-folder",
      name: "Recovered folder",
      created_at: INITIAL.created_at,
      updated_at: INITIAL.updated_at,
    },
    db.getPrivateSpaceId()
  );

  await service.syncNotes();
  assert.equal(listCalls(cloud, "snapshot").length, 2, "HTTP success alone is not completion");
  assertCleared(db.getNote(note.id), "content");
  assert.equal(db.getNote(note.id).folder_id, folder.id);
  await service.syncNotes();
  assert.equal(listCalls(cloud, "snapshot").length, 2);
  assert.equal(updateCalls(cloud).length, 0);
});

test("a retry that finds a changed cloud base keeps the clear as an unresolved conflict", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = preRevisionNote(db);
  db.updateNote(note.id, { clear_fields: ["content"] });
  const changed = {
    ...INITIAL,
    revision: 8,
    content: "Newer cloud text",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
  const cloud = recoveryCloud({ notes: [changed], failedSnapshots: 1 });
  const service = await client(t, db, cloud);

  await service.syncNotes();
  assert.equal(listCalls(cloud, "snapshot").length, 1);
  assert.deepEqual(readNoteConflicts(), {});
  await service.syncNotes();
  assert.equal(listCalls(cloud, "snapshot").length, 2);
  assert.deepEqual(readNoteConflicts()[INITIAL.client_note_id], changed);
  for (let pass = 0; pass < 2; pass++) await service.syncNotes();
  reopen(db);
  assert.equal(listCalls(cloud, "snapshot").length, 2);
  assert.equal(updateCalls(cloud).length, 0);
  assert.equal(db.getNote(note.id).content, "");
  assert.equal(db.getNote(note.id).content_sync_operation, "clear");
  assert.equal(db.getNote(note.id).sync_status, "pending");
  assert.equal(db.getNote(note.id).cloud_revision, null);
  assert.equal(cloud.row().content, changed.content);
  assert.deepEqual(readNoteConflicts()[INITIAL.client_note_id], changed);
});
