const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");
const { resolveCloudNoteCreate } = require("../../src/services/noteCreateAck.ts");
const { buildNoteUpdatePayload } = require("../../src/helpers/cloudSyncGuards.js");

const UPDATED = "2026-10-09T10:00:00.000Z";

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

function dependencies(db) {
  return {
    acknowledge: (...args) => db.acknowledgeNoteCreate(...args),
    deleteCloud: () => assert.fail("An idempotent retry does not own the existing server row"),
  };
}

for (const field of ["content", "enhanced_content"]) {
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
