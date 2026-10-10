const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");
const {
  resolveCloudNoteCreate,
  resolveCloudNoteCreateBatch,
} = require("../../src/services/noteCreateAck.ts");
const { buildNoteUpdatePayload } = require("../../src/helpers/cloudSyncGuards.js");

const UPDATED = "2026-10-09T10:00:00.000Z";
const SUMMARY_METADATA = [
  "enhancement_prompt",
  "enhanced_at_content_hash",
  "enhancement_template_id",
];

function fresh(db) {
  const note = db.saveNote("Lost first response", "Original content").note;
  db.updateNote(note.id, {
    enhanced_content: "Original summary",
    enhancement_prompt: "Original prompt",
    enhanced_at_content_hash: "original-hash",
    enhancement_template_id: "original-template",
    transcript: "Protected transcript",
  });
  return db.getNote(note.id);
}

function response(note, overrides = {}) {
  return {
    id: `cloud-${note.id}`,
    client_note_id: note.client_note_id,
    user_id: "owner",
    content: note.content,
    enhanced_content: note.enhanced_content,
    enhancement_prompt: note.enhancement_prompt,
    enhanced_at_content_hash: note.enhanced_at_content_hash,
    enhancement_template_id: note.enhancement_template_id,
    content_state: "set",
    enhanced_content_state: "set",
    revision: 2,
    write_applied: true,
    created_at: UPDATED,
    updated_at: UPDATED,
    ...overrides,
  };
}

function cleared(note, field) {
  return response(note, {
    [field]: field === "content" ? "" : null,
    [`${field}_state`]: "clear",
    ...(field === "enhanced_content" && {
      enhancement_prompt: null,
      enhanced_at_content_hash: null,
    }),
  });
}

function receipt(row) {
  return Object.fromEntries(
    ["id", "client_note_id", "revision", "updated_at", "write_applied"].map((key) => [
      key,
      row[key],
    ])
  );
}

function dependencies(db, rows = []) {
  return {
    acknowledge: (...args) => db.acknowledgeNoteCreate(...args),
    deleteCloud: () => assert.fail("An idempotent retry does not own the existing server row"),
    listCloud: async () => ({ notes: rows }),
  };
}

for (const field of ["content", "enhanced_content"]) {
  for (const batch of [false, true]) {
    test(`${field}: accepted ${batch ? "batch receipt" : "full row"} reconciles an ignored resend`, async (t) => {
      const db = createDb(t);
      if (!db) return;
      const snapshot = fresh(db);
      const cloud = cleared(snapshot, field);
      const deps = dependencies(db, [cloud]);
      const outcome = batch
        ? (await resolveCloudNoteCreateBatch([snapshot], [receipt(cloud)], deps))[0]
        : await resolveCloudNoteCreate(snapshot, cloud, deps);
      assert.equal(outcome, "synced");
      const local = db.getNote(snapshot.id);
      assert.equal(local[field] ?? "", "");
      assert.equal(local[`${field}_sync_operation`], null);
      assert.equal(local.cloud_revision, cloud.revision);
      assert.equal(local.owner_user_id, "owner");
      assert.equal(local.transcript, "Protected transcript");
      if (field === "enhanced_content") {
        assert.equal(local.enhancement_prompt, null);
        assert.equal(local.enhanced_at_content_hash, null);
        assert.equal(local.enhancement_template_id, "original-template");
      }
      // A later unrelated edit must not re-send the text the server cleared.
      db.updateNote(local.id, { title: "Later title" });
      assert.equal(
        buildNoteUpdatePayload(db.getNote(local.id), null).field_updates[field],
        undefined
      );
    });
  }

  test(`${field}: a newer edit stays pending while the other clear is reconciled`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const snapshot = fresh(db);
    const other = field === "content" ? "enhanced_content" : "content";
    db.updateNote(snapshot.id, { [field]: "New in-flight edit" });
    const cloud = cleared(snapshot, other);
    assert.equal(await resolveCloudNoteCreate(snapshot, cloud, dependencies(db)), "pending");
    const local = db.getNote(snapshot.id);
    assert.equal(local[field], "New in-flight edit");
    assert.equal(local[`${field}_sync_operation`], "set");
    assert.equal(local[other] ?? "", "");
    assert.equal(local[`${other}_sync_operation`], null);
  });

  test(`${field}: an in-flight clear and Undo that restores the submitted text remains a new set`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const snapshot = fresh(db);
    db.updateNote(
      snapshot.id,
      { [field]: "", clear_fields: [field] },
      {
        undoable: true,
        expected: snapshot,
      }
    );
    assert.equal(db.undoNoteUpdate(db.getNoteUndos()[0].token).success, true);
    assert.equal(db.getNote(snapshot.id)[field], snapshot[field]);
    const outcome = await resolveCloudNoteCreate(
      snapshot,
      cleared(snapshot, field),
      dependencies(db)
    );
    assert.equal(outcome, "pending");
    const local = db.getNote(snapshot.id);
    assert.equal(
      local[field],
      snapshot[field],
      "Undo is later local intent, even when values match"
    );
    assert.equal(local[`${field}_sync_operation`], "set");
  });

  test(`${field}: an in-flight clear is not replaced by the create's returned text`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const snapshot = fresh(db);
    db.updateNote(snapshot.id, { clear_fields: [field] });
    assert.equal(
      await resolveCloudNoteCreate(snapshot, response(snapshot), dependencies(db)),
      "pending"
    );
    assert.equal(db.getNote(snapshot.id)[field] ?? "", "");
    assert.equal(db.getNote(snapshot.id)[`${field}_sync_operation`], "clear");
  });
}

test("a later title Undo survives reconciliation of an unrelated cleared field", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const snapshot = fresh(db);
  db.updateNote(snapshot.id, { title: "Assistant title" }, { undoable: true, expected: snapshot });
  const token = db.getNoteUndos()[0].token;
  assert.equal(
    await resolveCloudNoteCreate(snapshot, cleared(snapshot, "content"), dependencies(db)),
    "pending"
  );
  assert.equal(db.getNote(snapshot.id).content, "");
  assert.equal(db.getNoteUndos()[0]?.token, token);
  assert.equal(db.undoNoteUpdate(token).success, true);
  assert.equal(db.getNote(snapshot.id).title, snapshot.title);
  assert.equal(db.getNote(snapshot.id).content, "");
});

for (const key of SUMMARY_METADATA) {
  test(`summary reconciliation preserves later ${key}`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const snapshot = fresh(db);
    db.updateNote(snapshot.id, { [key]: "New summary metadata" });
    await resolveCloudNoteCreate(snapshot, cleared(snapshot, "enhanced_content"), dependencies(db));
    const local = db.getNote(snapshot.id);
    assert.equal(local.enhanced_content, snapshot.enhanced_content);
    assert.equal(local[key], "New summary metadata");
    assert.equal(local.enhanced_content_sync_operation, "set");
    assert.equal(local.sync_status, "pending");
  });
}

test("partial migration acknowledges returned text but remains pending for omitted fields", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const snapshot = fresh(db);
  const cloud = cleared(snapshot, "enhanced_content");
  assert.equal(
    await resolveCloudNoteCreate(snapshot, cloud, dependencies(db), { settleIfUnchanged: false }),
    "pending"
  );
  assert.equal(db.getNote(snapshot.id).enhanced_content, null);
  assert.equal(db.getNote(snapshot.id).enhanced_content_sync_operation, null);
  assert.equal(db.getNote(snapshot.id).transcript, snapshot.transcript);
});

test("normal first creates settle without a lookup, including revision-zero receipts", async (t) => {
  const db = createDb(t);
  if (!db) return;
  for (const full of [false, true]) {
    const snapshot = fresh(db);
    const cloud = response(snapshot, { revision: 0 });
    assert.equal(
      await resolveCloudNoteCreate(snapshot, full ? cloud : receipt(cloud), {
        ...dependencies(db),
        listCloud: () => assert.fail("First create already proves the submitted values"),
      }),
      "synced"
    );
  }
});

test("batch receipts share an identity-checked composite-cursor lookup", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const one = fresh(db);
  const two = fresh(db);
  const first = cleared(one, "content");
  const second = cleared(two, "enhanced_content");
  const page = Array.from({ length: 100 }, (_, i) => ({
    ...first,
    id: `unrelated-${i}`,
    client_note_id: `unrelated-client-${i}`,
  }));
  page[0] = first;
  const calls = [];
  const outcome = await resolveCloudNoteCreateBatch([one, two], [receipt(first), receipt(second)], {
    ...dependencies(db),
    listCloud: async (...args) => {
      calls.push(args);
      return { notes: calls.length === 1 ? page : [second] };
    },
  });
  assert.deepEqual(outcome, ["synced", "synced"]);
  assert.deepEqual(calls, [
    [100, undefined, undefined],
    [100, UPDATED, "unrelated-99"],
  ]);
  assert.equal(db.getNote(one.id).content, "");
  assert.equal(db.getNote(two.id).enhanced_content, null);
});

for (const kind of ["missing", "wrong-client", "wrong-id", "deleted", "access-removed", "error"]) {
  test(`${kind} hydration leaves an accepted receipt unlinked and retriable`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const snapshot = fresh(db);
    const cloud = cleared(snapshot, "content");
    const rows =
      kind === "missing"
        ? []
        : [
            {
              ...cloud,
              ...(kind === "wrong-client" && { client_note_id: "other-client" }),
              ...(kind === "wrong-id" && { id: "other-id" }),
              ...(kind === "deleted" && { deleted_at: UPDATED }),
              ...(kind === "access-removed" && { access_removed: true }),
            },
          ];
    const deps = dependencies(db, rows);
    if (kind === "error")
      deps.listCloud = async () => {
        throw new Error("Offline");
      };
    assert.equal(await resolveCloudNoteCreate(snapshot, receipt(cloud), deps), "unresolved");
    assert.deepEqual(db.getNote(snapshot.id), snapshot);
    assert.equal(
      await resolveCloudNoteCreate(snapshot, receipt(cloud), dependencies(db, [cloud])),
      "synced"
    );
    assert.equal(db.getNote(snapshot.id).content, "");
  });
}

test("a newer hydrated revision parks without granting its base to local work", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const snapshot = fresh(db);
  const original = cleared(snapshot, "content");
  const later = { ...original, revision: 3, updated_at: "2026-10-09T10:01:00.000Z" };
  assert.equal(
    await resolveCloudNoteCreate(snapshot, receipt(original), dependencies(db, [later])),
    "write-rejected"
  );
  const local = db.getNote(snapshot.id);
  assert.equal(local.cloud_id, original.id);
  assert.equal(local.cloud_revision, null);
  assert.equal(local.cloud_updated_at, null);
  assert.equal(local.cloud_create_rejected, 1);
  assert.equal(local.content, snapshot.content);
  assert.equal(local.content_sync_operation, "set");
});

test("account invalidation during receipt lookup never acknowledges or deletes the existing row", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const snapshot = fresh(db);
  const cloud = cleared(snapshot, "content");
  let current = true;
  assert.equal(
    await resolveCloudNoteCreate(
      snapshot,
      receipt(cloud),
      {
        ...dependencies(db),
        listCloud: async () => {
          current = false;
          return { notes: [cloud] };
        },
      },
      { requestStillCurrent: () => current }
    ),
    "unresolved"
  );
  assert.deepEqual(db.getNote(snapshot.id), snapshot);
});

test("an accepted reused row is not deleted when its local identity disappears", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const snapshot = fresh(db);
  const deps = dependencies(db);
  deps.acknowledge = async () => ({ success: true, outcome: "orphaned" });
  assert.equal(
    await resolveCloudNoteCreate(snapshot, cleared(snapshot, "content"), deps),
    "unresolved"
  );
});

test("a stale cached lookup retries without granting an old base", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const snapshot = fresh(db);
  const cloud = cleared(snapshot, "content");
  assert.equal(
    await resolveCloudNoteCreate(
      snapshot,
      receipt(cloud),
      dependencies(db, [response(snapshot, { revision: 0 })])
    ),
    "unresolved"
  );
  assert.deepEqual(db.getNote(snapshot.id), snapshot);
});

test("rejected creates do not fetch, adopt returned text, or clean up an existing row", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const snapshot = fresh(db);
  const cloud = { ...cleared(snapshot, "content"), write_applied: false };
  assert.equal(
    await resolveCloudNoteCreate(snapshot, cloud, {
      ...dependencies(db),
      listCloud: () => assert.fail("Rejected creates wait for normal conflict resolution"),
    }),
    "write-rejected"
  );
  const local = db.getNote(snapshot.id);
  assert.equal(local.cloud_revision, null);
  assert.equal(local.content, snapshot.content);
  assert.equal(local.content_sync_operation, "set");
  assert.equal(local.cloud_create_rejected, 1);
});

test("local edit generations migrate additively, survive reopen, and reject renderer overrides", (t) => {
  const db = createDb(t);
  if (!db) return;
  const snapshot = fresh(db);
  db.db.exec("ALTER TABLE notes DROP COLUMN content_edit_generation");
  db.db.exec("ALTER TABLE notes DROP COLUMN enhanced_content_edit_generation");
  db.db.close();
  db.initDatabase();
  assert.equal(db.getNote(snapshot.id).content_edit_generation, 0);
  assert.equal(db.getNote(snapshot.id).enhanced_content_edit_generation, 0);
  db.updateNote(snapshot.id, { content: "New text", content_edit_generation: 90 });
  db.updateNote(snapshot.id, { enhancement_template_id: "New template" });
  db.updateNote(snapshot.id, { title: "Only title", enhanced_content_edit_generation: 90 });
  db.db.close();
  db.initDatabase();
  assert.equal(db.getNote(snapshot.id).content_edit_generation, 1);
  assert.equal(db.getNote(snapshot.id).enhanced_content_edit_generation, 1);
  assert.equal(
    buildNoteUpdatePayload(db.getNote(snapshot.id), null).content_edit_generation,
    undefined
  );
});

for (const field of ["content", "enhanced_content"]) {
  test(`${field}: PATCH acknowledgement also preserves a same-value later Undo`, (t) => {
    const db = createDb(t);
    if (!db) return;
    const original = fresh(db);
    db.acknowledgeNoteCreate(original.id, original, `cloud-${original.id}`, UPDATED, null, {
      cloudRevision: 0,
    });
    db.updateNote(original.id, { [field]: "Submitted edit" });
    const snapshot = db.getNote(original.id);
    db.updateNote(
      original.id,
      { [field]: "", clear_fields: [field] },
      { undoable: true, expected: snapshot }
    );
    db.undoNoteUpdate(db.getNoteUndos()[0].token);
    const ack = db.markNoteSyncedIfUnchanged(
      original.id,
      snapshot,
      snapshot.cloud_id,
      UPDATED,
      null,
      1,
      response(snapshot)
    );
    assert.equal(ack.outcome, "pending");
    assert.equal(db.getNote(original.id)[field], "Submitted edit");
    assert.equal(db.getNote(original.id)[`${field}_sync_operation`], "set");
  });
}

test("partial migration submits the whole summary group and keeps omitted fields pending", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const snapshot = fresh(db);
  const {
    installBrowserGlobals,
    resetBrowserGlobals,
    window: windowStub,
    stopSyncTimers,
  } = require("./harness/browserGlobals.js");
  resetBrowserGlobals();
  installBrowserGlobals();
  windowStub.electronAPI = {
    getNotes: async () => [snapshot],
    acknowledgeNoteCreate: async (...args) => db.acknowledgeNoteCreate(...args),
  };
  const { startMigration } = await import("../../src/stores/noteStore.ts");
  const { NotesService } = require("../../src/services/NotesService.ts");
  const { syncService } = require("../../src/services/SyncService.ts");
  t.after(() => stopSyncTimers(syncService));
  t.mock.method(NotesService, "batchCreate", async ([input]) => {
    assert.equal(input.enhanced_at_content_hash, snapshot.enhanced_at_content_hash);
    assert.equal(input.transcript, undefined);
    return { created: [receipt(response(snapshot, { revision: 0 }))] };
  });
  await startMigration();
  const local = db.getNote(snapshot.id);
  assert.equal(local.cloud_revision, 0);
  assert.equal(local.enhanced_at_content_hash, snapshot.enhanced_at_content_hash);
  assert.equal(local.transcript, snapshot.transcript);
  assert.equal(local.sync_status, "pending");
});
