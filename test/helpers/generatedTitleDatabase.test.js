const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");

for (const titleMatches of [true, false]) {
  test(`generated title ${titleMatches ? "applies to the original title" : "preserves a saved rename"} while saving the summary`, (t) => {
    const db = createDb(t);
    assert.ok(db);
    db.setActiveAccountId("test-account");
    const note = db.saveNote("Untitled Note", "Meeting notes", "personal").note;
    if (!titleMatches) db.updateNote(note.id, { title: "Customer Alpha handoff" });
    const result = db.updateNote(
      note.id,
      {
        title: "Release Schedule",
        enhanced_content: "Ship Friday.",
        enhancement_prompt: "Summarize",
        enhanced_at_content_hash: "hash",
      },
      { titleIfUnchanged: "Untitled Note" }
    );
    assert.equal(result.success, true);
    assert.equal(result.generatedTitleApplied, titleMatches);
    assert.equal(result.note.title, titleMatches ? "Release Schedule" : "Customer Alpha handoff");
    assert.equal(result.note.enhanced_content, "Ship Friday.");
    assert.equal(result.note.enhancement_prompt, "Summarize");
    assert.equal(result.note.enhanced_content_sync_operation, "set");
  });
}

test("conditional naming preserves account scope and missing-note failures", (t) => {
  const db = createDb(t);
  assert.ok(db);
  db.setActiveAccountId("test-account");
  const note = db.saveNote("Untitled Note", "Meeting notes", "personal").note;
  db.setActiveAccountId("another-account");
  const result = db.updateNote(
    note.id,
    { title: "Generated" },
    { titleIfUnchanged: "Untitled Note" }
  );
  assert.equal(result.success, false);
  db.setActiveAccountId("test-account");
  assert.equal(db.getNote(note.id).title, "Untitled Note");
  assert.equal(
    db.updateNote(-1, { title: "Generated" }, { titleIfUnchanged: "Untitled Note" }).success,
    false
  );
  assert.equal(db.updateNote(note.id, { title: "Manual" }).success, true);
  assert.equal(db.getNote(note.id).title, "Manual");
});
