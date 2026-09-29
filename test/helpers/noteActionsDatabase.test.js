const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  DETAILED_NOTES_KEY,
  FOLLOW_UP_EMAIL_KEY,
  NOTE_ACTION_LIMITS,
} = require("../../src/helpers/builtinActions.js");

const SECTIONS = [{ heading: "Blockers", instruction: "Anything stuck" }];

function createTemplate(db, name = "Stand-up") {
  return db.createAction(name, "", "", "sparkles", { sections: SECTIONS }).action;
}

function rawRow(db, id) {
  return db.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
}

function cloudAction(fields = {}) {
  return {
    id: "cloud-1",
    client_action_id: "client-1",
    kind: "action",
    name: "Shorten",
    description: "",
    prompt: "Make the summary shorter",
    sections: null,
    output: "summary",
    icon: null,
    sort_order: 7,
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
    deleted_at: null,
    ...fields,
  };
}

test("only custom rows within the limits are pending, and an edit re-queues a synced one", (t) => {
  const db = createDb(t);
  if (!db) return;
  const followUp = db.getActions().find((a) => a.translation_key === FOLLOW_UP_EMAIL_KEY);
  db.updateAction(followUp.id, { prompt: "My own follow-up email" });
  assert.deepEqual(db.getPendingNoteActions(), [], "built-ins never sync, even when edited");

  const template = createTemplate(db);
  // A row saved before the limits existed.
  db.db
    .prepare("INSERT INTO actions (name, prompt, client_id) VALUES (?, ?, ?)")
    .run("Legacy", "x".repeat(NOTE_ACTION_LIMITS.prompt + 1), "legacy-client");

  const pending = db.getPendingNoteActions();
  assert.deepEqual(
    pending.map((row) => row.id),
    [template.id]
  );
  assert.deepEqual(pending[0].sections, SECTIONS);

  db.markNoteActionSynced(template.id, "cloud-1", "2026-07-01T10:00:00.000Z", pending[0]);
  assert.deepEqual(db.getPendingNoteActions(), []);

  db.updateAction(template.id, { name: "Daily stand-up" });
  assert.deepEqual(
    db.getPendingNoteActions().map((row) => row.id),
    [template.id]
  );
});

test("deleting removes an unsynced row and leaves a synced one as a pending tombstone", (t) => {
  const db = createDb(t);
  if (!db) return;
  const draft = createTemplate(db, "Draft");
  const synced = createTemplate(db, "Synced");
  const [pushed] = db.getPendingNoteActions().filter((row) => row.id === synced.id);
  db.markNoteActionSynced(synced.id, "cloud-1", "2026-07-01T10:00:00.000Z", pushed);

  assert.deepEqual(db.deleteAction(draft.id), { success: true, id: draft.id });
  assert.equal(rawRow(db, draft.id), undefined);

  assert.deepEqual(db.deleteAction(synced.id), { success: true, id: synced.id });
  assert.equal(db.getAction(synced.id), null);
  assert.equal(
    db.getActions().some((a) => a.id === synced.id),
    false
  );
  assert.equal(db.updateAction(synced.id, { name: "Back" }).success, false);
  assert.equal(db.deleteAction(synced.id).success, false);

  const [tombstone] = db.getPendingNoteActionDeletes();
  assert.equal(tombstone.id, synced.id);
  assert.equal(tombstone.cloud_id, "cloud-1");
  assert.ok(tombstone.deleted_at);
});

test("markNoteActionSynced leaves a row pending when it changed since the push", (t) => {
  const db = createDb(t);
  if (!db) return;
  const template = createTemplate(db);
  const [pushed] = db.getPendingNoteActions();

  // Only the sections change while the push is in flight.
  db.updateAction(template.id, { sections: [{ heading: "Wins", instruction: "" }] });
  const stale = db.markNoteActionSynced(template.id, "cloud-1", "2026-07-01T10:00:00.000Z", pushed);
  assert.equal(stale.changes, 0);
  const [current] = db.getPendingNoteActions();
  assert.equal(current.cloud_id, null);

  const ok = db.markNoteActionSynced(template.id, "cloud-1", "2026-07-01T11:00:00.000Z", current);
  assert.equal(ok.changes, 1);
  const row = rawRow(db, template.id);
  assert.equal(row.sync_status, "synced");
  assert.equal(row.cloud_id, "cloud-1");
  assert.equal(row.updated_at, "2026-07-01T11:00:00.000Z");

  db.clearNoteActionCloudId(template.id);
  assert.equal(db.getPendingNoteActions()[0].cloud_id, null);
});

test("cloud rows insert, merge by client id then cloud id, and revive a local tombstone", (t) => {
  const db = createDb(t);
  if (!db) return;
  const inserted = db.upsertNoteActionFromCloud(cloudAction());
  assert.equal(inserted.kind, "action");
  assert.equal(inserted.output, "summary");
  assert.equal(inserted.client_id, "client-1");
  assert.equal(inserted.sort_order, 7);
  assert.equal(inserted.icon, "sparkles");
  assert.equal(rawRow(db, inserted.id).sync_status, "synced");

  const updated = db.upsertNoteActionFromCloud(
    cloudAction({ name: "Shorten more", updated_at: "2026-07-01T11:00:00.000Z" })
  );
  assert.equal(updated.id, inserted.id);
  assert.equal(updated.name, "Shorten more");
  assert.equal(
    db.getNoteActionForCloudMerge({ id: "cloud-1", client_action_id: "unknown" }).id,
    inserted.id
  );

  db.deleteAction(inserted.id);
  const revived = db.upsertNoteActionFromCloud(
    cloudAction({ name: "Edited elsewhere", updated_at: "2026-07-01T12:00:00.000Z" })
  );
  assert.equal(revived.id, inserted.id);
  assert.equal(revived.name, "Edited elsewhere");
  assert.deepEqual(db.getPendingNoteActionDeletes(), []);
});

test("a cloud row never overwrites or deletes a built-in, and a malformed one is ignored", (t) => {
  const db = createDb(t);
  if (!db) return;
  const builtin = db.getActions().find((a) => a.translation_key === DETAILED_NOTES_KEY);

  const hijack = cloudAction({
    client_action_id: DETAILED_NOTES_KEY,
    kind: "template",
    prompt: "Say hi",
    output: null,
  });
  assert.equal(db.upsertNoteActionFromCloud(hijack), null);
  assert.equal(db.hardDeleteNoteAction(builtin.id).success, false);
  assert.deepEqual(db.getAction(builtin.id), builtin);

  assert.equal(db.upsertNoteActionFromCloud(cloudAction({ kind: "recipe" })), null);
  assert.equal(db.upsertNoteActionFromCloud(cloudAction({ prompt: "" })), null);
  assert.equal(
    db.getActions().some((a) => a.client_id === "client-1"),
    false
  );
});
