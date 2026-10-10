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
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const {
  buildNoteCreatePayload,
  buildNoteUpdatePayload,
  isCloudNoteNewer,
} = require("../../src/helpers/cloudSyncGuards.js");
const { noteAwaitsCloudResolution } = require("../../src/helpers/noteFieldSync.js");
const {
  readNoteConflictIds,
  readNoteConflicts,
  removeNoteConflictId,
} = require("../../src/lib/noteConflictRegistry.ts");
const { documentSaveUpdates } = require("../../src/lib/noteEditorPendingSave.ts");

const INITIAL = {
  id: "cloud-note",
  client_note_id: "client-note",
  title: "Meeting",
  content: "Personal notes\n\nRemove this section",
  enhanced_content: "Summary\n\nRemove this section",
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
const copy = (value) => JSON.parse(JSON.stringify(value));
const SUMMARY_KEYS = ["enhancement_prompt", "enhancement_template_id", "enhanced_at_content_hash"];

test("explicit server clears replace stored text while an empty transcript remains protected", (t) => {
  const db = createDb(t);
  if (!db) return;
  const original = db.upsertNoteFromCloud(INITIAL, null);
  db.upsertNoteFromCloud(
    {
      ...INITIAL,
      revision: 8,
      content: "",
      enhanced_content: null,
      content_state: "clear",
      enhanced_content_state: "clear",
      transcript: null,
    },
    null
  );
  reopen(db);
  const reopened = db.getNote(original.id);
  assert.equal(reopened.content, "");
  assert.equal(reopened.enhanced_content, null);
  assert.equal(reopened.enhancement_prompt, null);
  // The template is the note's choice and survives a summary clear.
  assert.equal(reopened.enhancement_template_id, INITIAL.enhancement_template_id);
  assert.equal(reopened.transcript, INITIAL.transcript);
});

// Only HTTP is simulated here. The API companion tests run its real SQL and
// validation; this fixture exercises the desktop save/push/ack/pull boundary.
function protocolCloud(initial = INITIAL) {
  let row = copy(initial);
  const fallback = createFakeCloud();
  const calls = [];
  // The text each clear removed: a legacy write resending exactly it is ignored.
  const removed = {};
  return {
    calls,
    row: () => copy(row),
    replace: (next) => {
      row = copy(next);
    },
    async request(opts) {
      calls.push(copy(opts));
      if (opts.path.startsWith("/api/notes/list"))
        return { success: true, data: { notes: [copy(row)] } };
      if (opts.path !== "/api/notes/update") return fallback.request(opts);
      const input = copy(opts.body);
      const revisioned = Number.isSafeInteger(row.revision);
      const mobile = opts.headers?.["x-openwhispr-platform"] === "mobile";
      if (input.base_revision !== undefined && input.base_revision !== row.revision)
        return {
          success: false,
          status: 409,
          code: "note_version_conflict",
          details: { note: copy(row) },
        };
      for (const [field, operation] of Object.entries(input.field_updates ?? {})) {
        if ((operation === "clear") === Boolean(input[field]?.trim()))
          return { success: false, status: 400, code: "validation_error" };
      }
      row.title = input.title ?? row.title;
      for (const field of ["content", "enhanced_content"]) {
        let operation = input.field_updates?.[field];
        if (
          !operation &&
          !mobile &&
          input.base_revision === undefined &&
          input[field] === removed[field]
        )
          continue;
        // Only mobile's timestamp-based legacy blank is an explicit clear.
        // Desktop blanks still write, but leave their intent unknown.
        if (!operation && input[field]?.trim()) operation = "set";
        if (!operation && input[field] === "" && input.base_revision === undefined) {
          if (revisioned && mobile && input.base_updated_at) operation = "clear";
          else {
            if (revisioned && row[field]) row[`${field}_state`] = null;
            row[field] = "";
            continue;
          }
        }
        if (!operation) continue;
        if (operation === "clear") removed[field] = row[field];
        row[field] = operation === "clear" ? (field === "content" ? "" : null) : input[field];
        if (revisioned) row[`${field}_state`] = operation;
        if (field === "enhanced_content") {
          for (const meta of ["enhancement_prompt", "enhanced_at_content_hash"])
            row[meta] = operation === "clear" ? null : (input[meta] ?? null);
          if (operation === "set")
            row.enhancement_template_id = input.enhancement_template_id ?? null;
        }
      }
      if (revisioned) row.revision += 1;
      row.updated_at = new Date(Date.parse(row.updated_at) + 1).toISOString();
      return { success: true, data: copy(row) };
    },
  };
}

async function client(t, db, cloud) {
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  windowStub.electronAPI = createElectronApi(db, { cloud });
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return service;
}

function reopen(db) {
  const filename = db.db.name;
  db.db.close();
  db.db = new (require("better-sqlite3"))(filename);
}

for (const field of ["content", "enhanced_content"]) {
  test(`${field}: an offline deliberate clear reaches a second client and survives reopen; Undo is a newer edit`, async (t) => {
    const a = createDb(t);
    const b = createDb(t);
    if (!a || !b) return;
    const cloud = protocolCloud();
    const noteA = a.upsertNoteFromCloud(INITIAL, null);
    const noteB = b.upsertNoteFromCloud(INITIAL, null);
    assert.equal(a.updateNote(noteA.id, { clear_fields: [field] }).success, true);
    // A later title autosave resends the now-blank document after debounce.
    a.updateNote(noteA.id, { title: "Renamed offline", [field]: a.getNote(noteA.id)[field] });
    reopen(a);
    assert.equal(a.getNote(noteA.id)[`${field}_sync_operation`], "clear");
    await (await client(t, a, cloud)).pushPendingNotes();
    assert.equal(a.getNote(noteA.id).sync_status, "synced");
    await (await client(t, b, cloud)).pullNotes(false, true);
    reopen(b);
    assert.equal(b.getNote(noteB.id)[field] ?? "", "");
    assert.equal(b.getNote(noteB.id).transcript, INITIAL.transcript);
    const other = field === "content" ? "enhanced_content" : "content";
    assert.equal(b.getNote(noteB.id)[other], INITIAL[other]);
    if (field === "enhanced_content") {
      for (const meta of ["enhancement_prompt", "enhanced_at_content_hash"])
        assert.equal(b.getNote(noteB.id)[meta], null);
      assert.equal(b.getNote(noteB.id).enhancement_template_id, INITIAL.enhancement_template_id);
    }
    a.updateNote(noteA.id, { [field]: INITIAL[field] });
    await (await client(t, a, cloud)).pushPendingNotes();
    await (await client(t, b, cloud)).pullNotes(false, true);
    assert.equal(b.getNote(noteB.id)[field], INITIAL[field]);
    assert.equal(b.getNote(noteB.id).cloud_revision, 9);
    cloud.replace({ ...INITIAL, updated_at: "2099-01-01T00:00:00Z" });
    await (await client(t, b, cloud)).pullNotes(false, true);
    assert.equal(
      b.getNote(noteB.id).cloud_revision,
      9,
      "an old revision cannot win through clock skew"
    );
  });

  test(`${field}: absent, null, blank and unmarked whitespace pulls preserve good text`, (t) => {
    const db = createDb(t);
    if (!db) return;
    const original = db.upsertNoteFromCloud(INITIAL, null);
    for (const value of [undefined, null, "", "\t\n", "\u00a0"]) {
      const incoming = { ...INITIAL, revision: 8, [field]: value };
      delete incoming[`${field}_state`];
      db.upsertNoteFromCloud(copy(incoming), null);
      assert.equal(db.getNote(original.id)[field], INITIAL[field]);
      assert.equal(db.getNote(original.id).transcript, INITIAL.transcript);
    }
  });

  test(`${field}: a partial edit and a clear followed by in-flight Undo retain separate intent`, (t) => {
    const db = createDb(t);
    if (!db) return;
    const original = db.upsertNoteFromCloud(INITIAL, null);
    db.updateNote(original.id, { [field]: "Retained section" });
    assert.equal(buildNoteUpdatePayload(db.getNote(original.id), null).field_updates[field], "set");
    db.updateNote(original.id, { clear_fields: [field] });
    const snapshot = db.getNote(original.id);
    db.updateNote(original.id, { [field]: INITIAL[field] });
    const result = db.markNoteSyncedIfUnchanged(
      original.id,
      snapshot,
      INITIAL.id,
      "2026-01-01T00:00:01Z",
      INITIAL.user_id,
      8
    );
    assert.equal(result.outcome, "pending");
    const pending = db.getNote(original.id);
    assert.equal(pending[field], INITIAL[field]);
    assert.equal(pending[`${field}_sync_operation`], "set");
    assert.equal(buildNoteUpdatePayload(pending, null).base_revision, 8);
    db.markNoteSyncedIfUnchanged(
      original.id,
      pending,
      INITIAL.id,
      "2026-01-01T00:00:02Z",
      INITIAL.user_id,
      9
    );
    db.markNoteSyncedIfUnchanged(
      original.id,
      snapshot,
      INITIAL.id,
      "2099-01-01T00:00:00Z",
      INITIAL.user_id,
      8
    );
    assert.equal(db.getNote(original.id).cloud_revision, 9);
  });
}

test("against an API without revisions, a clear with a timestamp base pushes as a blank and settles", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { revision: _revision, ...legacy } = INITIAL;
  const row = db.upsertNoteFromCloud(legacy, null);
  db.updateNote(row.id, { clear_fields: ["content", "enhanced_content"] });
  const pending = db.getNote(row.id);
  // A server that keeps revisions would store this legacy blank as unknown
  // intent, not a clear, so there the clear waits for a revision.
  assert.equal(noteAwaitsCloudResolution(pending, true), true);
  assert.equal(noteAwaitsCloudResolution(pending, false), false);
  const payload = buildNoteUpdatePayload(pending, null);
  assert.equal(payload.base_revision, undefined);
  assert.equal(payload.base_updated_at, INITIAL.updated_at);
  assert.equal(payload.content, "");
  assert.equal(payload.enhanced_content, "");
  // A pre-protocol API answers without a revision; the ack still settles.
  assert.equal(
    db.markNoteSyncedIfUnchanged(row.id, pending, INITIAL.id, INITIAL.updated_at).outcome,
    "synced"
  );
  assert.equal(db.getNote(row.id).content_sync_operation, null);
});

test("an unconfirmed local blank is never pushed as a clear", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { content: "", enhanced_content: null, title: "Renamed" });
  const payload = buildNoteUpdatePayload(db.getNote(row.id), null);
  assert.equal("content" in JSON.parse(JSON.stringify(payload)), false);
  assert.equal("enhanced_content" in JSON.parse(JSON.stringify(payload)), false);
  assert.deepEqual(payload.field_updates, {});
});

test("a clear on a pre-guard row adopts the revision without a false conflict", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { cloud_updated_at: null, cloud_revision: null });
  db.db.prepare("UPDATE notes SET cloud_revision = NULL WHERE id = ?").run(row.id);
  db.updateNote(row.id, { clear_fields: ["content"] });
  assert.equal(noteAwaitsCloudResolution(db.getNote(row.id), true), true);
  assert.equal(noteAwaitsCloudResolution(db.getNote(row.id), false), false);
  const cloud = protocolCloud();
  await (await client(t, db, cloud)).pushPendingNotes();
  assert.equal(readNoteConflictIds().has(INITIAL.client_note_id), false);
  assert.equal(db.getNote(row.id).sync_status, "synced");
  assert.equal(cloud.row().content, "");
  assert.equal(cloud.row().content_state, "clear");
  assert.ok(
    cloud.calls.findIndex((call) => call.path.startsWith("/api/notes/list")) <
      cloud.calls.findIndex((call) => call.path === "/api/notes/update")
  );
});

test("rejects unsupported/contradictory clears; another cloud row or account is skipped, not thrown", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  assert.equal(db.updateNote(row.id, { clear_fields: ["transcript"] }).success, false);
  assert.equal(
    db.updateNote(row.id, { content: "Keep me", clear_fields: ["content"] }).success,
    false
  );
  assert.equal(db.getNote(row.id).transcript, INITIAL.transcript);
  const skipped = db.upsertNoteFromCloud({ ...INITIAL, id: "other-cloud", content: "Other" }, null);
  assert.equal(skipped, null);
  assert.equal(db.getNote(row.id).content, INITIAL.content);
  db.updateNote(row.id, { cloud_id: null, client_note_id: "forked-identity" });
  assert.equal(db.getNote(row.id).cloud_revision, null);
  assert.equal(
    db.markNoteSyncedIfUnchanged(row.id, row, INITIAL.id, INITIAL.updated_at, INITIAL.user_id, 8)
      .outcome,
    "identity-changed"
  );
});

test("pulls adopt unattributed rows and personal<->team moves instead of aborting", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const unattributed = db.upsertNoteFromCloud(INITIAL, null);
  db.db.prepare("UPDATE notes SET account_id = NULL WHERE id = ?").run(unattributed.id);
  const moved = db.upsertNoteFromCloud(
    { ...INITIAL, revision: 8, title: "Edited elsewhere" },
    null
  );
  assert.equal(moved.title, "Edited elsewhere");
  assert.equal(moved.account_id, db.getNote(unattributed.id).account_id);

  // A full pull carries on past such a row to the notes after it.
  db.db.prepare("UPDATE notes SET account_id = NULL WHERE id = ?").run(unattributed.id);
  const second = { ...INITIAL, id: "cloud-2", client_note_id: "client-2", title: "Brand new" };
  const cloud = {
    request: async (opts) =>
      opts.path.startsWith("/api/notes/list")
        ? {
            success: true,
            data: { notes: [{ ...INITIAL, revision: 9, title: "Again" }, second] },
          }
        : createFakeCloud().request(opts),
  };
  assert.equal(await (await client(t, db, cloud)).pullNotes(false, true), true);
  assert.equal(db.getNote(unattributed.id).title, "Again");
  assert.equal(db.getNoteByClientId("client-2")?.title, "Brand new");
});

test("an API without revisions still applies pulls and settles pushes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  const { revision: _revision, ...legacy } = INITIAL;
  db.upsertNoteFromCloud(
    { ...legacy, title: "Edited after rollback", updated_at: "2026-02-01T00:00:00.000Z" },
    null
  );
  assert.equal(db.getNote(row.id).title, "Edited after rollback");
  assert.equal(db.getNote(row.id).cloud_revision, null);
  assert.equal(isCloudNoteNewer({ updated_at: "2099-01-01T00:00:00Z" }, db.getNote(row.id)), true);
  db.updateNote(row.id, { title: "Local" });
  const snapshot = db.getNote(row.id);
  db.db.prepare("UPDATE notes SET cloud_revision = 9 WHERE id = ?").run(row.id);
  assert.equal(
    db.markNoteSyncedIfUnchanged(row.id, snapshot, INITIAL.id, INITIAL.updated_at).outcome,
    "pending",
    "the snapshot no longer matches the row's revision"
  );
  const current = db.getNote(row.id);
  assert.equal(
    db.markNoteSyncedIfUnchanged(row.id, current, INITIAL.id, INITIAL.updated_at).outcome,
    "synced"
  );
  assert.equal(db.getNote(row.id).cloud_revision, null);
});

test("creating a note with typed text settles in one request; a clear still follows", (t) => {
  const db = createDb(t);
  if (!db) return;
  for (const [edit, expected] of [
    [{ content: "Typed offline" }, "synced"],
    [{ clear_fields: ["content"] }, "pending"],
  ]) {
    const note = db.saveNote("Offline", "Draft").note;
    db.updateNote(note.id, edit);
    const snapshot = db.getNote(note.id);
    const ack = db.acknowledgeNoteCreate(
      note.id,
      snapshot,
      `cloud-${note.id}`,
      INITIAL.updated_at,
      null,
      { cloudRevision: 0 }
    );
    assert.equal(ack.outcome, expected);
    const after = db.getNote(note.id);
    assert.equal(after.content_sync_operation, expected === "synced" ? null : "clear");
  }
});

test("revisions order same-timestamp pulls and outrank clock skew", () => {
  const local = { cloud_revision: 8, updated_at: INITIAL.updated_at };
  assert.equal(isCloudNoteNewer({ ...INITIAL, revision: 9 }, local), true);
  assert.equal(
    isCloudNoteNewer({ ...INITIAL, revision: 7, updated_at: "2099-01-01T00:00:00Z" }, local),
    false
  );
});

test("Keep merges per field: local edits stay, untouched fields take the cloud's set or clear", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { title: "Local rename" });
  // A revision adopted at a pull grants no edit.
  db.setNoteCloudBase(row.id, INITIAL.updated_at, 8);
  assert.deepEqual(buildNoteUpdatePayload(db.getNote(row.id), null).field_updates, {});
  db.updateNote(row.id, { content: "Edited locally" });
  const cloudNote = {
    ...INITIAL,
    revision: 9,
    content: "Edited elsewhere",
    enhanced_content: "Rewritten elsewhere",
    enhancement_prompt: "Other prompt",
    enhanced_at_content_hash: "other-hash",
    enhancement_template_id: "other-template",
    enhanced_content_state: "set",
  };
  const { note } = db.setNoteCloudBase(row.id, INITIAL.updated_at, 9, {
    keepLocal: true,
    cloudNote,
  });
  assert.equal(note.content, "Edited locally");
  for (const key of [
    "enhanced_content",
    "enhancement_prompt",
    "enhanced_at_content_hash",
    "enhancement_template_id",
  ])
    assert.equal(note[key], cloudNote[key]);
  assert.equal(note.title, "Local rename");
  assert.deepEqual(buildNoteUpdatePayload(note, null).field_updates, { content: "set" });
  assert.equal(db.setNoteCloudBase(row.id, INITIAL.updated_at, 8).success, false);
  assert.equal(db.getNote(row.id).cloud_revision, 9);
});

test("Keep takes another device's clear of a field this device never edited", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { content: "Edited locally" });
  const result = db.setNoteCloudBase(row.id, INITIAL.updated_at, 8, {
    keepLocal: true,
    cloudNote: {
      ...INITIAL,
      revision: 8,
      content: "",
      content_state: "clear",
      enhanced_content: null,
      enhanced_content_state: "clear",
    },
  });
  assert.equal(result.note.content, "Edited locally");
  assert.equal(result.note.enhanced_content, null);
  assert.equal(result.note.enhancement_prompt, null);
  assert.equal(result.note.enhanced_at_content_hash, null);
  assert.equal(result.note.enhancement_template_id, INITIAL.enhancement_template_id);
  assert.deepEqual(buildNoteUpdatePayload(result.note, null).field_updates, { content: "set" });
});

test("Keep never treats an unmarked cloud blank as a clear and never re-pushes untouched text", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { title: "Local rename" });
  const { note } = db.setNoteCloudBase(row.id, INITIAL.updated_at, 9, {
    keepLocal: true,
    cloudNote: { ...INITIAL, revision: 9, content: "", enhanced_content: null },
  });
  assert.equal(note.content, INITIAL.content);
  assert.equal(note.enhanced_content, INITIAL.enhanced_content);
  assert.deepEqual(buildNoteUpdatePayload(note, null).field_updates, {});
});

test("a rejected create retry links without a fresh base and parks stale intent as a conflict", async (t) => {
  const { resolveCloudNoteCreate } = require("../../src/services/noteCreateAck.ts");
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { cloud_id: null, content: "Offline edit" });
  const snapshot = db.getNote(row.id);
  const cloud = protocolCloud({
    ...INITIAL,
    revision: 12,
    content: "Newer device edit",
    content_state: "set",
    updated_at: "2026-01-02T00:00:00Z",
  });
  const outcome = await resolveCloudNoteCreate(
    snapshot,
    { ...cloud.row(), write_applied: false },
    {
      acknowledge: (...args) => db.acknowledgeNoteCreate(...args),
      deleteCloud: () => assert.fail("Rejected create must never delete"),
    }
  );
  assert.equal(outcome, "write-rejected");
  assert.equal(db.getNote(row.id).cloud_revision, null);
  assert.equal(db.getNote(row.id).cloud_updated_at, INITIAL.updated_at, "no fresh base");
  reopen(db);
  assert.equal(db.getNote(row.id).cloud_create_rejected, 1);
  assert.equal(noteAwaitsCloudResolution(db.getNote(row.id), false), true);
  const service = await client(t, db, cloud);
  await service.pushPendingNotes();
  await service.pullNotes(false, true);
  await service.pushPendingNotes();
  assert.equal(cloud.row().content, "Newer device edit");
  assert.equal(db.getNote(row.id).content, "Offline edit");
  assert.notEqual(db.getNote(row.id).sync_status, "synced");
});

test("a rejected legacy create stays parked across failed pulls, restart, and debounced push", async (t) => {
  const { resolveCloudNoteCreate } = require("../../src/services/noteCreateAck.ts");
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { cloud_id: null, cloud_updated_at: null, content: "Old local text" });
  const snapshot = db.getNote(row.id);
  await resolveCloudNoteCreate(
    snapshot,
    { ...INITIAL, write_applied: false },
    {
      acknowledge: (...args) => db.acknowledgeNoteCreate(...args),
      deleteCloud: () => assert.fail("Never delete a rejected create"),
    }
  );
  reopen(db);
  const fallback = createFakeCloud();
  let patches = 0;
  const cloud = {
    request: async (opts) => {
      if (opts.path.startsWith("/api/notes/list")) throw new Error("Offline");
      if (opts.path === "/api/notes/update") patches++;
      return fallback.request(opts);
    },
  };
  const service = await client(t, db, cloud);
  await service.pushPendingNotes();
  const requestRetry = t.mock.method(service, "requestSyncAll", () => {});
  await service.pushNote(row.id);
  assert.equal(requestRetry.mock.callCount(), 1);
  assert.equal(patches, 0);
  assert.equal(db.getNote(row.id).cloud_create_rejected, 1);
  // Keep clears quarantine only through the deliberate conflict resolution.
  db.setNoteCloudBase(row.id, INITIAL.updated_at, INITIAL.revision);
  assert.equal(db.getNote(row.id).cloud_create_rejected, 1);
  db.setNoteCloudBase(row.id, INITIAL.updated_at, INITIAL.revision, { keepLocal: true });
  assert.equal(db.getNote(row.id).cloud_create_rejected, 0);
  assert.equal(buildNoteUpdatePayload(db.getNote(row.id), null).field_updates.content, "set");
});

const listCalls = (cloud, kind) =>
  cloud.calls.filter((call) => {
    if (!call.path.startsWith("/api/notes/list")) return false;
    const query = new URLSearchParams(call.path.split("?")[1] ?? "");
    if (kind === "probe") return query.get("limit") === "1";
    return query.get("limit") !== "1" && !query.has("since");
  });
const updateCalls = (cloud) => cloud.calls.filter((call) => call.path === "/api/notes/update");
const withoutRevision = (db, id) =>
  db.db.prepare("UPDATE notes SET cloud_revision = NULL WHERE id = ?").run(id);

function unansweredRevisionProbeOnce(
  cloud,
  response = { success: false, status: 503, error: "Temporary capability discovery outage" }
) {
  let failed = false;
  return {
    ...cloud,
    async request(opts) {
      const query = new URLSearchParams(opts.path.split("?")[1] ?? "");
      if (!failed && opts.path.startsWith("/api/notes/list") && query.get("limit") === "1") {
        failed = true;
        cloud.calls.push(copy(opts));
        return copy(response);
      }
      return cloud.request(opts);
    },
  };
}

for (const field of ["content", "enhanced_content"]) {
  for (const timestampBase of [true, false]) {
    const baseLabel = timestampBase ? "with a timestamp base" : "without a timestamp base";

    test(`${field}: legacy blanks ${baseLabel} distinguish desktop unknown intent from mobile clears`, async () => {
      for (const platform of ["desktop", "mobile"]) {
        const cloud = protocolCloud();
        const result = await cloud.request({
          path: "/api/notes/update",
          headers: { "x-openwhispr-platform": platform },
          body: {
            id: INITIAL.id,
            [field]: "",
            ...(timestampBase ? { base_updated_at: INITIAL.updated_at } : {}),
          },
        });
        const clear = platform === "mobile" && timestampBase;
        assert.equal(result.success, true);
        assert.equal(cloud.row()[field] ?? "", "");
        assert.equal(cloud.row()[`${field}_state`], clear ? "clear" : null);
        if (field === "enhanced_content") {
          assert.equal(cloud.row().enhancement_prompt, clear ? null : INITIAL.enhancement_prompt);
          assert.equal(
            cloud.row().enhanced_at_content_hash,
            clear ? null : INITIAL.enhanced_at_content_hash
          );
          assert.equal(cloud.row().enhancement_template_id, INITIAL.enhancement_template_id);
        }
      }
    });

    test(`${field}: failed capability discovery ${baseLabel} preserves a clear until a revisioned retry converges`, async (t) => {
      const a = createDb(t);
      const b = createDb(t);
      if (!a || !b) return;
      const noteA = a.upsertNoteFromCloud(INITIAL, null);
      const noteB = b.upsertNoteFromCloud(INITIAL, null);
      withoutRevision(a, noteA.id);
      if (!timestampBase)
        a.db.prepare("UPDATE notes SET cloud_updated_at = NULL WHERE id = ?").run(noteA.id);
      a.updateNote(noteA.id, { clear_fields: [field] });
      const cloud = unansweredRevisionProbeOnce(protocolCloud());
      const service = await client(t, a, cloud);
      const ack = t.mock.method(windowStub.electronAPI, "markNoteSyncedIfUnchanged");
      const adoptBase = t.mock.method(windowStub.electronAPI, "setNoteCloudBase");

      await service.pushPendingNotes();
      assert.equal(listCalls(cloud, "probe").length, 1);
      assert.equal(updateCalls(cloud).length, 0);
      assert.equal(ack.mock.callCount(), 0);
      assert.equal(adoptBase.mock.callCount(), 0);
      assert.deepEqual(cloud.row(), INITIAL);
      reopen(a);
      assert.equal(a.getNote(noteA.id).sync_status, "pending");
      assert.equal(a.getNote(noteA.id)[`${field}_sync_operation`], "clear");
      assert.equal(a.getNote(noteA.id).cloud_revision, null);

      await service.pushPendingNotes();
      assert.equal(listCalls(cloud, "probe").length, 2);
      assert.equal(listCalls(cloud, "full").length, 1);
      assert.equal(adoptBase.mock.callCount(), 1);
      assert.deepEqual(adoptBase.mock.calls[0].arguments, [
        noteA.id,
        INITIAL.updated_at,
        INITIAL.revision,
      ]);
      assert.equal(updateCalls(cloud).length, 1);
      const payload = updateCalls(cloud)[0].body;
      assert.equal(payload.base_revision, INITIAL.revision);
      assert.equal(payload.base_updated_at, INITIAL.updated_at);
      assert.deepEqual(payload.field_updates, { [field]: "clear" });
      assert.equal(payload[field], "");
      assert.equal(ack.mock.callCount(), 1);
      assert.equal(a.getNote(noteA.id).sync_status, "synced");
      assert.equal(a.getNote(noteA.id)[`${field}_sync_operation`], null);
      assert.equal(a.getNote(noteA.id).cloud_revision, cloud.row().revision);
      assert.equal(cloud.row()[`${field}_state`], "clear");

      await (await client(t, b, cloud)).pullNotes(false, true);
      reopen(b);
      const peer = b.getNote(noteB.id);
      assert.equal(peer[field] ?? "", "");
      const other = field === "content" ? "enhanced_content" : "content";
      assert.equal(peer[other], INITIAL[other]);
      assert.equal(peer.transcript, INITIAL.transcript);
      assert.equal(peer.cloud_revision, cloud.row().revision);
      assert.equal(peer.enhancement_template_id, INITIAL.enhancement_template_id);
      for (const meta of ["enhancement_prompt", "enhanced_at_content_hash"])
        assert.equal(peer[meta], field === "enhanced_content" ? null : INITIAL[meta]);
    });

    test(`${field}: observed old API ${baseLabel} retains the legacy clear fallback`, async (t) => {
      const db = createDb(t);
      if (!db) return;
      const {
        revision: _revision,
        content_state: _contentState,
        enhanced_content_state: _summaryState,
        ...legacy
      } = INITIAL;
      const row = db.upsertNoteFromCloud(legacy, null);
      if (!timestampBase)
        db.db.prepare("UPDATE notes SET cloud_updated_at = NULL WHERE id = ?").run(row.id);
      db.updateNote(row.id, { clear_fields: [field] });
      const cloud = protocolCloud(legacy);
      const service = await client(t, db, cloud);
      const ack = t.mock.method(windowStub.electronAPI, "markNoteSyncedIfUnchanged");
      await service.pushPendingNotes();
      assert.equal(listCalls(cloud, "probe").length, 1);
      assert.equal(listCalls(cloud, "full").length, 0);
      assert.equal(updateCalls(cloud).length, 1);
      const payload = updateCalls(cloud)[0].body;
      assert.equal(payload.base_revision, undefined);
      assert.equal(payload.field_updates, undefined);
      assert.equal(payload.base_updated_at, timestampBase ? INITIAL.updated_at : undefined);
      assert.equal(payload[field], "");
      assert.equal(cloud.row()[field], "");
      assert.equal(cloud.row().revision, undefined);
      assert.equal(ack.mock.callCount(), 1);
      assert.equal(db.getNote(row.id).sync_status, "synced");
      assert.equal(db.getNote(row.id)[`${field}_sync_operation`], null);
      assert.equal(db.getNote(row.id).cloud_revision, null);
      assert.equal(db.getNote(row.id).transcript, INITIAL.transcript);
    });
  }

  test(`${field}: a stale timestamp base after failed discovery remains a pending conflict`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const row = db.upsertNoteFromCloud(INITIAL, null);
    withoutRevision(db, row.id);
    db.updateNote(row.id, { clear_fields: [field] });
    const cloud = unansweredRevisionProbeOnce(protocolCloud());
    const service = await client(t, db, cloud);
    const ack = t.mock.method(windowStub.electronAPI, "markNoteSyncedIfUnchanged");
    await service.pushPendingNotes();
    const newer = {
      ...INITIAL,
      [field]: "Edited elsewhere during the outage",
      updated_at: "2026-01-02T00:00:00.000Z",
      revision: 8,
    };
    cloud.replace(newer);
    await service.pushPendingNotes();
    await service.pushPendingNotes();
    assert.equal(listCalls(cloud, "probe").length, 2);
    assert.equal(listCalls(cloud, "full").length, 1);
    assert.equal(updateCalls(cloud).length, 0);
    assert.equal(ack.mock.callCount(), 0);
    assert.equal(readNoteConflictIds().has(INITIAL.client_note_id), true);
    assert.deepEqual(cloud.row(), newer);
    assert.equal(db.getNote(row.id).sync_status, "pending");
    assert.equal(db.getNote(row.id)[`${field}_sync_operation`], "clear");
    assert.equal(db.getNote(row.id).cloud_revision, null);
    assert.equal(db.getNote(row.id).cloud_updated_at, INITIAL.updated_at);
  });
}

for (const [kind, notes] of [
  ["empty", []],
  [
    "access-removed",
    [{ id: INITIAL.id, client_note_id: INITIAL.client_note_id, access_removed: true }],
  ],
]) {
  test(`${kind} discovery remains unknown until a readable revision allows both clears`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const row = db.upsertNoteFromCloud(INITIAL, null);
    withoutRevision(db, row.id);
    db.updateNote(row.id, { clear_fields: ["content", "enhanced_content"] });
    const cloud = unansweredRevisionProbeOnce(protocolCloud(), { success: true, data: { notes } });
    const service = await client(t, db, cloud);
    const ack = t.mock.method(windowStub.electronAPI, "markNoteSyncedIfUnchanged");
    await service.pushPendingNotes();
    assert.equal(updateCalls(cloud).length, 0);
    assert.equal(ack.mock.callCount(), 0);
    assert.equal(db.getNote(row.id).sync_status, "pending");
    assert.equal(db.getNote(row.id).content_sync_operation, "clear");
    assert.equal(db.getNote(row.id).enhanced_content_sync_operation, "clear");
    assert.equal(db.getNote(row.id).cloud_revision, null);
    assert.deepEqual(cloud.row(), INITIAL);
    await service.pushPendingNotes();
    assert.equal(listCalls(cloud, "probe").length, 2);
    assert.equal(listCalls(cloud, "full").length, 1);
    assert.equal(updateCalls(cloud).length, 1);
    assert.equal(updateCalls(cloud)[0].body.base_revision, INITIAL.revision);
    assert.deepEqual(updateCalls(cloud)[0].body.field_updates, {
      content: "clear",
      enhanced_content: "clear",
    });
    assert.equal(ack.mock.callCount(), 1);
    assert.equal(db.getNote(row.id).sync_status, "synced");
    assert.equal(cloud.row().content_state, "clear");
    assert.equal(cloud.row().enhanced_content_state, "clear");
  });
}

function rejectCreate(db, row, { cloudUpdatedAt = INITIAL.updated_at } = {}) {
  db.updateNote(row.id, { cloud_id: null, cloud_updated_at: cloudUpdatedAt, content: "Offline" });
  const snapshot = db.getNote(row.id);
  db.acknowledgeNoteCreate(row.id, snapshot, INITIAL.id, cloudUpdatedAt, null, {
    settleIfUnchanged: false,
    writeRejected: true,
  });
  return db.getNote(row.id);
}

test("a rejected create already surfaced as a conflict is not re-pulled every pass", async (t) => {
  const db = createDb(t);
  if (!db) return;
  rejectCreate(db, db.upsertNoteFromCloud(INITIAL, null));
  const cloud = protocolCloud({ ...INITIAL, revision: 12, content: "Newer elsewhere" });
  const service = await client(t, db, cloud);
  await service.pushPendingNotes();
  assert.equal(readNoteConflictIds().has(INITIAL.client_note_id), true);
  await service.pushPendingNotes();
  await service.pushPendingNotes();
  assert.equal(listCalls(cloud, "full").length, 1);
  assert.equal(updateCalls(cloud).length, 0);
});

test("a base-less clear pushes as before against an API without revisions", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const { revision: _revision, ...legacy } = INITIAL;
  const row = db.upsertNoteFromCloud(legacy, null);
  db.db.prepare("UPDATE notes SET cloud_updated_at = NULL WHERE id = ?").run(row.id);
  db.updateNote(row.id, { clear_fields: ["content"] });
  const cloud = protocolCloud(legacy);
  const service = await client(t, db, cloud);
  // Rows a pull returned already show the server keeps no revisions.
  await service.pullNotes(false, true);
  await service.pushPendingNotes();
  await service.pushPendingNotes();
  assert.equal(listCalls(cloud, "full").length, 1);
  assert.equal(listCalls(cloud, "probe").length, 0);
  assert.equal(updateCalls(cloud)[0].body.content, "");
  assert.equal(db.getNote(row.id).sync_status, "synced");
});

test("a debounced push leaves a base-less clear to the full pass until revisions are ruled out", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.db
    .prepare("UPDATE notes SET cloud_updated_at = NULL, cloud_revision = NULL WHERE id = ?")
    .run(row.id);
  db.updateNote(row.id, { clear_fields: ["content"] });
  const cloud = protocolCloud();
  const service = await client(t, db, cloud);
  const requestPass = t.mock.method(service, "requestSyncAll", () => {});
  await service.pushNote(row.id);
  assert.equal(requestPass.mock.callCount(), 1);
  assert.equal(updateCalls(cloud).length, 0);
});

test("a base-less clear the pull cannot resolve waits without a full pull every pass", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.db
    .prepare("UPDATE notes SET cloud_updated_at = NULL, cloud_revision = NULL WHERE id = ?")
    .run(row.id);
  db.updateNote(row.id, { clear_fields: ["content"] });
  // The server keeps revisions but this note is missing from its list.
  const cloud = protocolCloud({ ...INITIAL, id: "cloud-other", client_note_id: "client-other" });
  const service = await client(t, db, cloud);
  for (let pass = 0; pass < 3; pass++) await service.pushPendingNotes();
  assert.equal(listCalls(cloud, "full").length, 1);
  assert.equal(updateCalls(cloud).length, 0);
  assert.equal(db.getNote(row.id).content_sync_operation, "clear");
});

// A delta feed with nothing new: an unchanged row never re-enters it.
function quietDelta(cloud) {
  return {
    request: async (opts) => {
      if (!opts.path.includes("since=")) return cloud.request(opts);
      cloud.calls.push(copy(opts));
      return { success: true, data: { notes: [] } };
    },
  };
}

// Another device cleared content while this one ran a release that kept the
// text; the delta cursor never re-delivers that row.
async function clearedElsewhere(t) {
  const db = createDb(t);
  if (!db) return null;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  withoutRevision(db, row.id);
  const cloud = protocolCloud();
  await cloud.request({
    path: "/api/notes/update",
    body: { id: INITIAL.id, base_revision: 7, field_updates: { content: "clear" }, content: "" },
  });
  // That release's pull kept the text but took the row's timestamps.
  db.db
    .prepare("UPDATE notes SET cloud_updated_at = ?, updated_at = ? WHERE id = ?")
    .run(cloud.row().updated_at, cloud.row().updated_at, row.id);
  return { db, row, cloud };
}

test("a push ack takes the server's clear of a field this device never edited", async (t) => {
  const ctx = await clearedElsewhere(t);
  if (!ctx) return;
  const { db, row, cloud } = ctx;
  db.updateNote(row.id, { title: "Renamed" });
  await (await client(t, db, cloud)).pushPendingNotes();
  const note = db.getNote(row.id);
  assert.equal(cloud.row().content, "", "the stale text was not resurrected");
  assert.equal(note.content, "");
  assert.equal(note.sync_status, "synced");
  assert.equal(note.cloud_revision, cloud.row().revision);
  db.updateNote(row.id, { content: "Typed after the clear" });
  await (await client(t, db, cloud)).pushPendingNotes();
  assert.equal(cloud.row().content, "Typed after the clear");
});

test("a debounced push ack takes the server's clear too", async (t) => {
  const ctx = await clearedElsewhere(t);
  if (!ctx) return;
  const { db, row, cloud } = ctx;
  db.updateNote(row.id, { title: "Renamed" });
  await (await client(t, db, cloud)).pushNote(row.id);
  assert.equal(db.getNote(row.id).content, "");
  assert.equal(db.getNote(row.id).sync_status, "synced");
});

test("an ack never overwrites a blank or summary metadata typed while the push was in flight", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { title: "Renamed" });
  const snapshot = db.getNote(row.id);
  db.updateNote(row.id, { content: "" });
  db.updateNote(row.id, { enhancement_prompt: "Typed prompt" });
  db.markNoteSyncedIfUnchanged(row.id, snapshot, INITIAL.id, INITIAL.updated_at, null, 8, {
    ...INITIAL,
    revision: 8,
  });
  assert.equal(db.getNote(row.id).content, "");
  assert.equal(db.getNote(row.id).enhancement_prompt, "Typed prompt");
  assert.notEqual(db.getNote(row.id).sync_status, "synced");
});

test("a pull applies a clean pre-revision row whole, so a missed clear arrives", async (t) => {
  const ctx = await clearedElsewhere(t);
  if (!ctx) return;
  const { db, row, cloud } = ctx;
  await (await client(t, db, cloud)).pullNotes(false, true);
  assert.equal(db.getNote(row.id).content, "");
  assert.equal(db.getNote(row.id).cloud_revision, cloud.row().revision);
});

test("one snapshot pull per session backfills clean rows synced before revisions", async (t) => {
  const ctx = await clearedElsewhere(t);
  if (!ctx) return;
  const { db, row, cloud } = ctx;
  // A row the pull cannot resolve keeps the count up; it still pulls once.
  withoutRevision(
    db,
    db.upsertNoteFromCloud(
      { ...INITIAL, id: "cloud-missing", client_note_id: "client-missing" },
      null
    ).id
  );
  const service = await client(t, db, quietDelta(cloud));
  localStorageStub.setItem("lastSyncedAt.notes", "2026-06-01T00:00:00.000Z");
  await service.syncNotes();
  await service.syncNotes();
  assert.equal(db.getNote(row.id).content, "");
  assert.equal(listCalls(cloud, "full").length, 1);
});

test("an API without revisions never gets the revision backfill pull", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const { revision: _revision, ...legacy } = INITIAL;
  db.upsertNoteFromCloud(legacy, null);
  const cloud = protocolCloud(legacy);
  const service = await client(t, db, quietDelta(cloud));
  localStorageStub.setItem("lastSyncedAt.notes", "2026-06-01T00:00:00.000Z");
  await service.syncNotes();
  await service.syncNotes();
  assert.equal(listCalls(cloud, "full").length, 0);
  assert.equal(listCalls(cloud, "probe").length, 1);
});

test("a push ack restores text the device left out as an unconfirmed blank", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { content: "", title: "Renamed" });
  const cloud = protocolCloud();
  await (await client(t, db, cloud)).pushPendingNotes();
  assert.equal(db.getNote(row.id).content, INITIAL.content);
  assert.equal(db.getNote(row.id).sync_status, "synced");
});

test("an in-flight ack adopts only fields untouched since the push", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { title: "Renamed" });
  const snapshot = db.getNote(row.id);
  db.updateNote(row.id, { content: "Typed after the push" });
  const result = db.markNoteSyncedIfUnchanged(
    row.id,
    snapshot,
    INITIAL.id,
    "2026-01-01T00:00:01.000Z",
    INITIAL.user_id,
    8,
    {
      ...INITIAL,
      revision: 8,
      content: "",
      content_state: "clear",
      enhanced_content: "Server summary",
      enhanced_content_state: "set",
      enhancement_prompt: "Server prompt",
    }
  );
  assert.equal(result.outcome, "pending");
  const note = db.getNote(row.id);
  assert.equal(note.content, "Typed after the push");
  assert.equal(note.content_sync_operation, "set");
  assert.equal(note.enhanced_content, "Server summary");
  assert.equal(note.enhancement_prompt, "Server prompt");
  assert.equal(note.enhanced_content_sync_operation, null);
  assert.equal(result.note.enhanced_content, "Server summary");
});

test("a pending pre-revision row with a stale base surfaces a conflict instead of overwriting", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  withoutRevision(db, row.id);
  db.updateNote(row.id, { content: "Local edit" });
  const cloud = protocolCloud({
    ...INITIAL,
    revision: 9,
    content: "Newer elsewhere",
    updated_at: "2026-01-05T00:00:00.000Z",
  });
  const service = await client(t, db, cloud);
  await service.pullNotes(false, true);
  assert.equal(readNoteConflictIds().has(INITIAL.client_note_id), true);
  assert.equal(db.getNote(row.id).cloud_revision, null);
  await service.pushPendingNotes();
  assert.equal(updateCalls(cloud).length, 0);
  assert.equal(cloud.row().content, "Newer elsewhere");
});

test("Refresh after a local clear drops the stale clear, so the next push is valid", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { clear_fields: ["content"] });
  const cloud = protocolCloud({ ...INITIAL, revision: 8, content: "Newer elsewhere" });
  db.upsertNoteFromCloud(cloud.row(), null);
  assert.equal(db.getNote(row.id).content_sync_operation, null);
  db.updateNote(row.id, { title: "Renamed" });
  await (await client(t, db, cloud)).pushPendingNotes();
  assert.equal(db.getNote(row.id).sync_status, "synced");
  assert.equal(cloud.row().content, "Newer elsewhere");
});

test("Refresh of a rejected create un-parks it", (t) => {
  const db = createDb(t);
  if (!db) return;
  const parked = rejectCreate(db, db.upsertNoteFromCloud(INITIAL, null));
  assert.equal(parked.cloud_create_rejected, 1);
  db.upsertNoteFromCloud({ ...INITIAL, revision: 12 }, null);
  assert.equal(db.getNote(parked.id).cloud_create_rejected, 0);
  assert.equal(noteAwaitsCloudResolution(db.getNote(parked.id), true), false);
});

test("a pull never applies another account's row", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.setActiveAccountId("account-b");
  db.upsertNoteFromCloud({ ...INITIAL, revision: 8, title: "Other account" }, null);
  const stored = db.db.prepare("SELECT * FROM notes WHERE id = ?").get(row.id);
  assert.equal(stored.title, INITIAL.title);
  assert.equal(stored.account_id, "account-a");
});

test("only a changed text field, or changed summary metadata, becomes a set", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, {
    title: "Renamed",
    content: INITIAL.content,
    enhanced_content: INITIAL.enhanced_content,
  });
  assert.deepEqual(buildNoteUpdatePayload(db.getNote(row.id), null).field_updates, {});
  db.updateNote(row.id, { enhancement_prompt: "New prompt" });
  assert.deepEqual(buildNoteUpdatePayload(db.getNote(row.id), null).field_updates, {
    enhanced_content: "set",
  });
});

test("a local summary clear drops its prompt and hash but keeps the template", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  const { note } = db.updateNote(row.id, { clear_fields: ["enhanced_content"] });
  assert.equal(note.enhancement_prompt, null);
  assert.equal(note.enhanced_at_content_hash, null);
  assert.equal(note.enhancement_template_id, INITIAL.enhancement_template_id);
});

test("a batch create the server refused stays parked", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Offline", "Draft").note;
  const cloud = protocolCloud();
  const rejecting = {
    request: async (opts) =>
      opts.path === "/api/notes/batch-create"
        ? {
            success: true,
            data: {
              created: opts.body.notes.map((input) => ({
                client_note_id: input.client_note_id,
                id: "cloud-existing",
                updated_at: "2026-01-09T00:00:00.000Z",
                revision: 12,
                write_applied: false,
              })),
            },
          }
        : cloud.request(opts),
  };
  const service = await client(t, db, rejecting);
  t.mock.method(service, "requestSyncAll", () => {});
  await service.pushPendingNotes();
  const parked = db.getNote(note.id);
  assert.equal(parked.cloud_create_rejected, 1);
  assert.equal(parked.cloud_id, "cloud-existing");
  assert.equal(parked.cloud_revision, null);
  assert.notEqual(parked.sync_status, "synced");
});

test("create payloads never carry a revision base or field operations", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { content: "Edited" });
  const payload = buildNoteCreatePayload(db.getNote(row.id), null);
  assert.equal("base_revision" in payload, false);
  assert.equal("field_updates" in payload, false);
  assert.equal(payload.content, "Edited");
  // A create carries the whole note, whatever revision a fork left behind.
  assert.equal(payload.enhanced_content, INITIAL.enhanced_content);
  for (const key of SUMMARY_KEYS) assert.equal(payload[key], INITIAL[key], key);
});

test("rejected creates never settle or take the response's base, at either ack", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { cloud_id: null, content: "Offline" });
  const snapshot = db.getNote(row.id);
  // Even a caller that asks to settle cannot settle a refused write.
  const ack = db.acknowledgeNoteCreate(row.id, snapshot, INITIAL.id, INITIAL.updated_at, null, {
    writeRejected: true,
  });
  assert.equal(ack.outcome, "pending");
  const parked = db.getNote(row.id);
  assert.equal(parked.cloud_create_rejected, 1);
  const patchAck = db.markNoteSyncedIfUnchanged(
    row.id,
    parked,
    INITIAL.id,
    "2026-01-09T00:00:00.000Z",
    INITIAL.user_id,
    12,
    { ...INITIAL, revision: 12, content: "Newer elsewhere" }
  );
  assert.equal(patchAck.outcome, "pending");
  const after = db.getNote(row.id);
  assert.equal(after.cloud_create_rejected, 1);
  assert.equal(after.cloud_revision, null);
  assert.equal(after.cloud_updated_at, INITIAL.updated_at);
  assert.equal(after.content, "Offline");
});

test("an upsert older than the acknowledged revision is ignored", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.upsertNoteFromCloud(
    { ...INITIAL, revision: 6, title: "Stale", updated_at: "2099-01-01T00:00:00.000Z" },
    null
  );
  assert.equal(db.getNote(row.id).title, INITIAL.title);
  assert.equal(db.getNote(row.id).cloud_revision, INITIAL.revision);
});

test("a rejected create surfaces a conflict even when the cloud row is older than the local edit", async (t) => {
  const db = createDb(t);
  if (!db) return;
  rejectCreate(db, db.upsertNoteFromCloud(INITIAL, null), { cloudUpdatedAt: null });
  const cloud = protocolCloud();
  await (await client(t, db, cloud)).pullNotes(false, true);
  assert.equal(readNoteConflictIds().has(INITIAL.client_note_id), true);
  assert.equal(db.getNoteByClientId(INITIAL.client_note_id).content, "Offline");
});

// --- Local text is the user's (F1), clears wait for a revision (F2), and
// opless text never travels on a revision-aware write (F3). ---

const DatabaseManager = require("../../src/helpers/database.js");
const SYNC_OPERATION_COLUMNS = ["content_sync_operation", "enhanced_content_sync_operation"];

// The database as a release without sync operations left it; reopening runs
// the upgrade.
function downgradeToReleasedSchema(db) {
  for (const column of SYNC_OPERATION_COLUMNS)
    db.db.exec(`ALTER TABLE notes DROP COLUMN ${column}`);
}
function upgrade(db) {
  db.db.close();
  db.initDatabase();
}
const operations = (note) => SYNC_OPERATION_COLUMNS.map((column) => note[column] ?? null);

test("every local writer records the text it writes as a set", (t) => {
  const db = createDb(t);
  if (!db) return;
  const typed = db.saveNote("Typed", "Typed body").note;
  assert.deepEqual(operations(typed), ["set", null]);
  assert.deepEqual(operations(db.saveNote("Meeting", "", "meeting").note), [null, null]);
  const { noteIds } = db.importNotes([
    { clientNoteId: "import-typed", title: "Imported", content: "Imported body" },
    { clientNoteId: "import-blank", title: "Blank", content: "   " },
  ]);
  assert.deepEqual(
    noteIds.map((id) => operations(db.getNote(id))),
    [
      ["set", null],
      [null, null],
    ]
  );
  const pulled = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(pulled.id, { content: "Edited" });
  assert.deepEqual(operations(db.getNote(pulled.id)), ["set", null]);
  const assisted = db.upsertNoteFromCloud(
    { ...INITIAL, id: "cloud-assisted", client_note_id: "client-assisted" },
    null
  );
  const result = db.updateNote(
    assisted.id,
    { enhanced_content: "Rewritten summary" },
    { undoable: true, expected: db.getNote(assisted.id) }
  );
  assert.equal(result.success, true);
  assert.deepEqual(operations(db.getNote(assisted.id)), [null, "set"]);
});

test("a create ack resets the operations a rejected create keeps; creates never send them", (t) => {
  const db = createDb(t);
  if (!db) return;
  const settled = db.saveNote("Settled", "Typed body").note;
  assert.equal(
    db.acknowledgeNoteCreate(settled.id, settled, "cloud-settled", INITIAL.updated_at, null, {
      cloudRevision: 0,
    }).outcome,
    "synced"
  );
  assert.deepEqual(operations(db.getNote(settled.id)), [null, null]);
  const rejected = db.saveNote("Rejected", "A offline text").note;
  const payload = buildNoteCreatePayload(rejected, null);
  assert.equal("field_updates" in payload, false);
  assert.equal("base_revision" in payload, false);
  assert.equal(payload.content, "A offline text");
  db.acknowledgeNoteCreate(rejected.id, rejected, "cloud-rejected", INITIAL.updated_at, null, {
    writeRejected: true,
  });
  assert.deepEqual(operations(db.getNote(rejected.id)), ["set", null]);
});

// S6c: the create was written, the server row changed, and the retry was
// refused. Keep must deliver the text this device created, not take the
// server's copy of a field it "never edited".
test("Keep after a refused create keeps and delivers the note's own text", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Rejected", "A offline text").note;
  const server = {
    ...INITIAL,
    client_note_id: note.client_note_id,
    title: "Rejected",
    content: "Server newer text",
    content_state: "set",
    enhanced_content: null,
    revision: 12,
    updated_at: "2026-01-09T00:00:00.000Z",
  };
  db.acknowledgeNoteCreate(note.id, note, server.id, null, null, { writeRejected: true });
  const kept = db.setNoteCloudBase(note.id, server.updated_at, server.revision, {
    keepLocal: true,
    cloudNote: server,
  }).note;
  assert.equal(kept.content, "A offline text");
  assert.deepEqual(buildNoteUpdatePayload(kept, null).field_updates, { content: "set" });
  const cloud = protocolCloud(server);
  await (await client(t, db, cloud)).pushPendingNotes();
  assert.equal(cloud.row().content, "A offline text");
  assert.equal(db.getNote(note.id).sync_status, "synced");
});

test("the upgrade marks unsynced text from a release as a set, once", (t) => {
  const db = createDb(t);
  if (!db) return;
  const synced = db.upsertNoteFromCloud(INITIAL, null);
  const edited = db.upsertNoteFromCloud(
    { ...INITIAL, id: "cloud-edited", client_note_id: "client-edited" },
    null
  );
  const blanked = db.upsertNoteFromCloud(
    { ...INITIAL, id: "cloud-blanked", client_note_id: "client-blanked" },
    null
  );
  const fresh = db.saveNote("Never synced", "Offline body").note;
  downgradeToReleasedSchema(db);
  // What a release wrote: an edit, a blank, a new note; no operations.
  db.db
    .prepare("UPDATE notes SET content = ?, sync_status = 'pending' WHERE id = ?")
    .run("Offline edit", edited.id);
  db.db
    .prepare(
      "UPDATE notes SET content = '', enhanced_content = NULL, sync_status = 'error' WHERE id = ?"
    )
    .run(blanked.id);
  upgrade(db);
  assert.deepEqual(operations(db.getNote(synced.id)), [null, null]);
  assert.deepEqual(operations(db.getNote(edited.id)), ["set", "set"]);
  assert.deepEqual(
    operations(db.getNote(blanked.id)),
    [null, null],
    "a release's blank is no clear"
  );
  assert.deepEqual(operations(db.getNote(fresh.id)), ["set", null]);
  db.db
    .prepare(
      "UPDATE notes SET content_sync_operation = NULL, enhanced_content_sync_operation = NULL"
    )
    .run();
  upgrade(db);
  assert.deepEqual(operations(db.getNote(edited.id)), [null, null], "runs only once");
});

test("a database from before sync status marks all its text as a set", (t) => {
  const db = createDb(t);
  if (!db) return;
  const Database = db.db.constructor;
  const bare = new Database(":memory:");
  t.after(() => bare.close());
  bare.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT, enhanced_content TEXT,
      content_sync_operation TEXT, enhanced_content_sync_operation TEXT);
    INSERT INTO notes (content, enhanced_content) VALUES ('Body', NULL), ('', 'Summary');
  `);
  DatabaseManager.prototype._markUnsyncedNoteTextAsSet.call({ db: bare });
  assert.deepEqual(
    bare
      .prepare("SELECT content_sync_operation, enhanced_content_sync_operation FROM notes")
      .all()
      .map(Object.values),
    [
      ["set", null],
      [null, "set"],
    ]
  );
});

// U3: an offline edit made on a release, then the upgrade, then a conflict.
test("Keep after the upgrade keeps an offline edit made on a release", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  withoutRevision(db, row.id);
  downgradeToReleasedSchema(db);
  db.db
    .prepare("UPDATE notes SET content = ?, sync_status = 'pending' WHERE id = ?")
    .run("Offline edit made on a release", row.id);
  upgrade(db);
  const cloud = protocolCloud({
    ...INITIAL,
    revision: 8,
    title: "Renamed elsewhere",
    updated_at: "2026-01-05T00:00:00.000Z",
  });
  const service = await client(t, db, cloud);
  await service.pullNotes(false, true);
  const conflict = readNoteConflicts()[INITIAL.client_note_id];
  assert.ok(conflict, "the stale base surfaces a conflict");
  const kept = db.setNoteCloudBase(row.id, conflict.updated_at, conflict.revision, {
    keepLocal: true,
    cloudNote: conflict,
  }).note;
  removeNoteConflictId(INITIAL.client_note_id);
  assert.equal(kept.content, "Offline edit made on a release");
  await service.pushPendingNotes();
  assert.equal(cloud.row().content, "Offline edit made on a release");
});

// U1: the server stores a desktop's legacy blank as unknown intent, so a clear
// pushed without a revision would never reach other devices.
test("a clear on a row with a timestamp base and no revision waits for one, then pushes as a clear", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  withoutRevision(db, row.id);
  db.updateNote(row.id, { title: "Meeting", content: "", clear_fields: ["content"] });
  const cloud = protocolCloud();
  const service = await client(t, db, cloud);
  const requestPass = t.mock.method(service, "requestSyncAll", () => {});
  await service.pushNote(row.id);
  assert.equal(requestPass.mock.callCount(), 1);
  assert.equal(updateCalls(cloud).length, 0, "the debounced push leaves it to the full pass");
  await service.pushPendingNotes();
  assert.equal(listCalls(cloud, "full").length, 1);
  const [push] = updateCalls(cloud);
  assert.equal(push.body.base_revision, INITIAL.revision);
  assert.deepEqual(push.body.field_updates, { content: "clear" });
  assert.equal(cloud.row().content_state, "clear");
  assert.equal(db.getNote(row.id).sync_status, "synced");
});

// N3: this device kept its text over a blank another client never marked as a
// clear. Sending that text back would overwrite newer text written elsewhere.
test("a revision-aware push leaves out text and summary metadata without an operation", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  const blank = { ...INITIAL, revision: 9, content: "", enhanced_content: null };
  db.upsertNoteFromCloud(blank, null);
  assert.equal(db.getNote(row.id).content, INITIAL.content, "the pull kept the local text");
  db.updateNote(row.id, { title: "Renamed" });
  const body = JSON.parse(JSON.stringify(buildNoteUpdatePayload(db.getNote(row.id), null)));
  for (const key of ["content", "enhanced_content", ...SUMMARY_KEYS])
    assert.equal(key in body, false, key);
  assert.deepEqual(body.field_updates, {});
  const cloud = protocolCloud(blank);
  await (await client(t, db, cloud)).pushPendingNotes();
  assert.equal(cloud.row().title, "Renamed");
  assert.equal(cloud.row().content, "", "the kept text was not resent");
  // An edit carries its field (and a summary edit its metadata); a row
  // without a revision still sends the full snapshot.
  db.updateNote(row.id, { enhanced_content: "Edited summary" });
  const edited = buildNoteUpdatePayload(db.getNote(row.id), null);
  assert.equal(edited.enhanced_content, "Edited summary");
  assert.equal(edited.enhancement_prompt, INITIAL.enhancement_prompt);
  assert.equal("content" in JSON.parse(JSON.stringify(edited)), false);
  withoutRevision(db, row.id);
  assert.equal(buildNoteUpdatePayload(db.getNote(row.id), null).content, INITIAL.content);
});

// U2b: an ack applies a clear made elsewhere while the editor's title save
// waits. The save then writes only the title, so the clear stays.
test("a title save after an ack applied a clear does not bring the text back", async (t) => {
  const ctx = await clearedElsewhere(t);
  if (!ctx) return;
  const { db, row, cloud } = ctx;
  const draft = db.getNote(row.id);
  db.updateNote(row.id, { title: "T1" });
  await (await client(t, db, cloud)).pushPendingNotes();
  assert.equal(db.getNote(row.id).content, "", "the ack took the clear");
  db.updateNote(
    row.id,
    documentSaveUpdates({
      noteId: row.id,
      title: "T12",
      content: draft.content,
      contentEdited: false,
      clearContent: false,
    })
  );
  assert.equal(db.getNote(row.id).content, "");
  assert.equal(db.getNote(row.id).content_sync_operation, null);
  await (await client(t, db, cloud)).pushPendingNotes();
  assert.equal(cloud.row().title, "T12");
  assert.equal(cloud.row().content, "");
  assert.equal(cloud.row().content_state, "clear");
});
