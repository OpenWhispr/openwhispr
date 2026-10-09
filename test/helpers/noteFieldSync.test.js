const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  establishValidatedAuth,
  enableSync,
  stopSyncTimers,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const {
  buildNoteUpdatePayload,
  isCloudNoteNewer,
} = require("../../src/helpers/cloudSyncGuards.js");
const { noteAwaitsCloudResolution } = require("../../src/helpers/noteFieldSync.js");
const { readNoteConflictIds } = require("../../src/lib/noteConflictRegistry.ts");

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
      if (input.base_revision !== undefined && input.base_revision !== row.revision)
        return {
          success: false,
          status: 409,
          code: "note_version_conflict",
          details: { note: copy(row) },
        };
      row.title = input.title ?? row.title;
      for (const field of ["content", "enhanced_content"]) {
        let operation = input.field_updates?.[field];
        // Legacy writes: text applies, and a blank from a client with a
        // timestamp base (and no revision) is a clear.
        if (!operation && input[field]?.trim()) operation = "set";
        if (
          !operation &&
          input[field] === "" &&
          input.base_updated_at &&
          input.base_revision === undefined
        )
          operation = "clear";
        if (!operation) continue;
        row[field] = operation === "clear" ? (field === "content" ? "" : null) : input[field];
        row[`${field}_state`] = operation;
        if (field === "enhanced_content") {
          for (const meta of ["enhancement_prompt", "enhanced_at_content_hash"])
            row[meta] = operation === "clear" ? null : (input[meta] ?? null);
          if (operation === "set")
            row.enhancement_template_id = input.enhancement_template_id ?? null;
        }
      }
      row.revision += 1;
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

test("a clear on a note with a timestamp base pushes as a blank and settles without a revision", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { revision: _revision, ...legacy } = INITIAL;
  const row = db.upsertNoteFromCloud(legacy, null);
  db.updateNote(row.id, { clear_fields: ["content", "enhanced_content"] });
  const pending = db.getNote(row.id);
  assert.equal(noteAwaitsCloudResolution(pending), false);
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
  assert.equal(noteAwaitsCloudResolution(db.getNote(row.id)), true);
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
  assert.equal(skipped.cloud_id, INITIAL.id);
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

test("Keep restores visible local text explicitly; capability negotiation grants no edit", (t) => {
  const db = createDb(t);
  if (!db) return;
  const row = db.upsertNoteFromCloud(INITIAL, null);
  db.updateNote(row.id, { title: "Local rename" });
  db.setNoteCloudBase(row.id, INITIAL.updated_at, 8);
  assert.deepEqual(buildNoteUpdatePayload(db.getNote(row.id), null).field_updates, {});
  db.setNoteCloudBase(row.id, INITIAL.updated_at, 9, { keepLocal: true });
  assert.deepEqual(buildNoteUpdatePayload(db.getNote(row.id), null).field_updates, {
    content: "set",
    enhanced_content: "set",
  });
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
    clearedFields: ["content", "enhanced_content"],
  });
  assert.equal(result.note.content, "Edited locally");
  assert.equal(result.note.enhanced_content, null);
  assert.equal(result.note.enhancement_prompt, null);
  assert.equal(result.note.enhancement_template_id, INITIAL.enhancement_template_id);
  assert.deepEqual(buildNoteUpdatePayload(result.note, null).field_updates, { content: "set" });
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
  reopen(db);
  assert.equal(db.getNote(row.id).cloud_create_rejected, 1);
  assert.equal(noteAwaitsCloudResolution(db.getNote(row.id)), true);
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
