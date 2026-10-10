const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");
const globals = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { resolveCloudNoteCreate } = require("../../src/services/noteCreateAck.ts");
const { readNoteConflictIds } = require("../../src/lib/noteConflictRegistry.ts");

function setup(t) {
  const db = createDb(t);
  assert.ok(db);
  const id = db.saveNote("Lost response", "Original notes").note.id;
  db.updateNote(id, {
    enhanced_content: "Original summary",
    enhancement_prompt: "Prompt",
    enhancement_template_id: "template",
    enhanced_at_content_hash: "hash",
    transcript: "Transcript",
  });
  const snapshot = db.getNote(id);
  const cloud = {
    ...snapshot,
    id: "cloud-note",
    user_id: "user-harness",
    folder_id: null,
    space_id: null,
    revision: 2,
    content_state: null,
    enhanced_content_state: null,
    updated_at: "2026-10-09T20:00:00.000Z",
    write_applied: true,
    row_created: false,
  };
  const acknowledge = (receipt = cloud, options) =>
    resolveCloudNoteCreate(
      snapshot,
      receipt,
      {
        acknowledge: async (...args) => db.acknowledgeNoteCreate(...args),
        deleteCloud: () => assert.fail("An existing row is not an orphan of this request"),
      },
      options
    );
  return { db, id, snapshot, cloud, acknowledge };
}

function reopen(db) {
  const filename = db.db.name;
  db.db.close();
  db.db = new (require("better-sqlite3"))(filename);
}

async function sync(t, db, cloud, { fail = false, missing = false } = {}) {
  globals.resetBrowserGlobals();
  globals.installBrowserGlobals();
  globals.enableSync();
  const fallback = createFakeCloud();
  const wire = {
    calls: [],
    async request(opts) {
      this.calls.push(opts);
      if (opts.path.startsWith("/api/notes/list")) {
        if (fail) return { success: false, status: 503, error: "offline" };
        return { success: true, data: { notes: missing ? [] : [cloud] } };
      }
      if (opts.path === "/api/notes/update") assert.fail("Must reconcile before PATCH");
      return fallback.request(opts);
    },
  };
  globals.window.electronAPI = createElectronApi(db, { cloud: wire });
  await globals.establishValidatedAuth();
  const service = new SyncService();
  t.after(() => globals.stopSyncTimers(service));
  return { service, wire };
}

function clear(cloud, field) {
  cloud[field] = field === "content" ? "" : null;
  cloud[`${field}_state`] = "clear";
  if (field === "enhanced_content") {
    cloud.enhancement_prompt = null;
    cloud.enhanced_at_content_hash = null;
  }
}

function lean(cloud) {
  const { id, client_note_id, updated_at, revision, write_applied, row_created } = cloud;
  return { id, client_note_id, updated_at, revision, write_applied, row_created };
}

for (const field of ["content", "enhanced_content"]) {
  for (const later of [null, "title", field, "enhancement_template_id"]) {
    test(`create receipt reconciles ${field} and preserves later ${later ?? "no edit"}`, async (t) => {
      const { db, id, cloud, acknowledge } = setup(t);
      clear(cloud, field);
      if (later) db.updateNote(id, { [later]: "Later edit" });
      await acknowledge();
      const note = db.getNote(id);
      const summaryEdited = field === "enhanced_content" && later === "enhancement_template_id";
      assert.equal(
        note[field] ?? "",
        later === field || summaryEdited
          ? later === field
            ? "Later edit"
            : "Original summary"
          : ""
      );
      assert.equal(
        note[`${field}_sync_operation`],
        later === field || summaryEdited ? "set" : null
      );
      assert.equal(note.sync_status, later ? "pending" : "synced");
      assert.equal(note.cloud_revision, cloud.revision);
      assert.equal(note.transcript, "Transcript");
      if (field === "enhanced_content" && !summaryEdited && later !== field) {
        assert.equal(note.enhancement_prompt, null);
        assert.equal(note.enhanced_at_content_hash, null);
        assert.equal(note.enhancement_template_id, "template");
      }
      if (later) assert.equal(note[later], "Later edit");
    });
  }

  test(`a lean create receipt recovers ${field} after failed/missing pulls and restart`, async (t) => {
    const { db, id, cloud, acknowledge } = setup(t);
    clear(cloud, field);
    await acknowledge(lean(cloud));
    assert.equal(db.getNote(id).sync_status, "pending");
    assert.ok(db.getNote(id).cloud_create_pending);
    assert.equal(db.getNote(id).cloud_create_rejected, 0);
    assert.equal(db.getNote(id).cloud_revision, null);
    reopen(db);
    await (await sync(t, db, cloud, { fail: true })).service.pushPendingNotes();
    await (await sync(t, db, cloud, { missing: true })).service.pushPendingNotes();
    assert.ok(db.getNote(id).cloud_create_pending);
    const { service } = await sync(t, db, cloud);
    await service.pullNotes(false, true);
    await service.pullNotes(false, true);
    reopen(db);
    assert.equal(db.getNote(id)[field] ?? "", "");
    assert.equal(db.getNote(id).sync_status, "synced");
    assert.equal(db.getNote(id).cloud_revision, cloud.revision);
    assert.equal(db.getNote(id).cloud_create_pending, null);
  });
}

for (const invalidated of [false, true]) {
  test(`an applied retry does not authorize orphan deletion (invalidated=${invalidated})`, async () => {
    const snapshot = { id: 42, client_note_id: "client-note" };
    for (const row_created of [false, undefined]) {
      const result = await resolveCloudNoteCreate(
        snapshot,
        {
          id: "existing",
          client_note_id: snapshot.client_note_id,
          write_applied: true,
          row_created,
        },
        {
          acknowledge: async () => ({ success: true, outcome: "orphaned" }),
          deleteCloud: () => assert.fail("No insertion proof"),
        },
        { requestStillCurrent: () => !invalidated }
      );
      assert.equal(result, "orphan-unproven");
    }
  });
}

test("a later server revision during deferred acknowledgement requires Keep/Refresh", async (t) => {
  const { db, id, snapshot, cloud, acknowledge } = setup(t);
  await acknowledge(lean(cloud));
  db.updateNote(id, { title: "My later title" });
  cloud.revision += 1;
  cloud.content = "Other device edit";
  const { service } = await sync(t, db, cloud);
  await service.pushPendingNotes();
  assert.ok(readNoteConflictIds().has(snapshot.client_note_id));
  assert.equal(db.getNote(id).title, "My later title");
  assert.equal(db.getNote(id).cloud_revision, null);
  assert.ok(db.getNote(id).cloud_create_pending);
  db.setNoteCloudBase(id, cloud.updated_at, cloud.revision, { keepLocal: true, cloudNote: cloud });
  assert.equal(db.getNote(id).cloud_create_pending, null);
});

test("Refresh clears deferred create recovery and takes the authoritative row", async (t) => {
  const { db, id, cloud, acknowledge } = setup(t);
  await acknowledge(lean(cloud));
  clear(cloud, "content");
  db.upsertNoteFromCloud(cloud, null);
  assert.equal(db.getNote(id).cloud_create_pending, null);
  assert.equal(db.getNote(id).content, "");
  assert.equal(db.getNote(id).sync_status, "synced");
});

test("a partial migration receipt reconciles text but leaves omitted work pending", async (t) => {
  const { db, id, cloud, acknowledge } = setup(t);
  clear(cloud, "content");
  await acknowledge(cloud, { settleIfUnchanged: false });
  assert.equal(db.getNote(id).content, "");
  assert.equal(db.getNote(id).content_sync_operation, null);
  assert.equal(db.getNote(id).sync_status, "pending");
  assert.equal(db.getNote(id).transcript, "Transcript");
});

test("API rollback without revisions retains unknown blanks while resolving a lean receipt", async (t) => {
  const { db, id, cloud, acknowledge } = setup(t);
  delete cloud.revision;
  delete cloud.content_state;
  delete cloud.enhanced_content_state;
  delete cloud.write_applied;
  delete cloud.row_created;
  cloud.content = "";
  await acknowledge(lean(cloud));
  reopen(db);
  await (await sync(t, db, cloud)).service.pullNotes(false, true);
  assert.equal(db.getNote(id).sync_status, "synced");
  assert.equal(db.getNote(id).content, "Original notes");
  assert.equal(db.getNote(id).cloud_revision, null);
  assert.equal(db.getNote(id).cloud_create_pending, null);
});

for (const receiptRevision of [true, false]) {
  test(`deferred create ignores an older pull (revision=${receiptRevision})`, async (t) => {
    const { db, id, cloud, acknowledge } = setup(t);
    if (!receiptRevision) delete cloud.revision;
    await acknowledge(lean(cloud));
    const stale = {
      ...cloud,
      revision: receiptRevision ? 1 : undefined,
      updated_at: "2026-10-09T19:00:00.000Z",
    };
    await (await sync(t, db, stale)).service.pullNotes(false, true);
    assert.equal(db.getNote(id).cloud_revision, null);
    assert.ok(db.getNote(id).cloud_create_pending);
    assert.equal(db.getNote(id).sync_status, "pending");
    await (await sync(t, db, cloud)).service.pullNotes(false, true);
    assert.equal(db.getNote(id).sync_status, "synced");
    assert.equal(db.getNote(id).cloud_create_pending, null);
  });
}

test("a deferred receipt preserves a later local edit while reconciling untouched text", async (t) => {
  const { db, id, cloud, acknowledge } = setup(t);
  clear(cloud, "content");
  await acknowledge(lean(cloud));
  db.updateNote(id, { title: "Later title" });
  reopen(db);
  await (await sync(t, db, cloud)).service.pullNotes(false, true);
  assert.equal(db.getNote(id).content, "");
  assert.equal(db.getNote(id).content_sync_operation, null);
  assert.equal(db.getNote(id).title, "Later title");
  assert.equal(db.getNote(id).sync_status, "pending");
  assert.equal(db.getNote(id).cloud_create_pending, null);
});

test("a deferred receipt with no later edit takes a newer server row as a whole", async (t) => {
  const { db, id, cloud, acknowledge } = setup(t);
  await acknowledge(lean(cloud));
  cloud.revision++;
  cloud.title = "Newer cloud title";
  clear(cloud, "content");
  await (await sync(t, db, cloud)).service.pullNotes(false, true);
  assert.equal(db.getNote(id).title, cloud.title);
  assert.equal(db.getNote(id).content, "");
  assert.equal(db.getNote(id).sync_status, "synced");
  assert.equal(db.getNote(id).cloud_revision, cloud.revision);
});

test("create acknowledgements never consume a deliberate clear that POST did not deliver", async (t) => {
  const { db, id, cloud } = setup(t);
  db.updateNote(id, { content: "", clear_fields: ["content"] });
  const snapshot = db.getNote(id);
  await resolveCloudNoteCreate(snapshot, cloud, {
    acknowledge: async (...args) => db.acknowledgeNoteCreate(...args),
    deleteCloud: () => assert.fail("Not an orphan"),
  });
  assert.equal(db.getNote(id).content, "");
  assert.equal(db.getNote(id).content_sync_operation, "clear");
  assert.equal(db.getNote(id).sync_status, "pending");
  assert.equal(db.getNote(id).cloud_revision, cloud.revision);
});

test("identity forks drop deferred receipts and prevent late acknowledgement", async (t) => {
  const { db, id, cloud, acknowledge } = setup(t);
  await acknowledge(lean(cloud));
  db.updateNote(id, { client_note_id: "forked", cloud_id: null });
  assert.equal(db.getNote(id).cloud_create_pending, null);
  assert.equal(await acknowledge(cloud), "orphan-unproven");
  assert.equal(db.getNote(id).cloud_id, null);
});
