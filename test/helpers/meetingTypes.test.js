const test = require("node:test");
const assert = require("node:assert/strict");

const { requireSqlite } = require("../support/sqlite.js");

function createTestDb(Database) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meeting_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      template TEXT NOT NULL DEFAULT '',
      is_builtin INTEGER NOT NULL DEFAULT 0,
      keyword_rules TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

test("seedMeetingTypes creates 7 built-in types", async () => {
  const Database = requireSqlite();
  const { seedMeetingTypes } = await import("../../src/helpers/meetingTypesData.js");
  const db = createTestDb(Database);
  seedMeetingTypes(db);

  const count = db.prepare("SELECT COUNT(*) as c FROM meeting_types WHERE is_builtin = 1").get();
  assert.equal(count.c, 7);
});

test("seedMeetingTypes is idempotent", async () => {
  const Database = requireSqlite();
  const { seedMeetingTypes } = await import("../../src/helpers/meetingTypesData.js");
  const db = createTestDb(Database);
  seedMeetingTypes(db);
  seedMeetingTypes(db);

  const count = db.prepare("SELECT COUNT(*) as c FROM meeting_types").get();
  assert.equal(count.c, 7);
});

// The per-type templates supply only the "Topics Covered" body; the standard
// sections come from the prompt wrapper, so assert on the composed prompt.
test("notes prompt for every built-in type requests Action Items", async () => {
  const Database = requireSqlite();
  const { seedMeetingTypes } = await import("../../src/helpers/meetingTypesData.js");
  const { GENERIC_NOTES_PROMPT, buildTypedNotesPrompt } = require("../../src/helpers/postCallPipelineManager.js");
  const db = createTestDb(Database);
  seedMeetingTypes(db);

  assert.ok(
    GENERIC_NOTES_PROMPT.toLowerCase().includes("action item"),
    "Generic notes prompt must request Action Items"
  );

  const types = db.prepare("SELECT name, template FROM meeting_types WHERE is_builtin = 1").all();
  for (const type of types) {
    assert.ok(type.template.trim().length > 0, `Built-in "${type.name}" must have a template`);
    const prompt = buildTypedNotesPrompt(type);
    assert.ok(
      prompt.toLowerCase().includes("action item"),
      `Notes prompt for "${type.name}" must request Action Items`
    );
    assert.ok(
      prompt.includes(type.template),
      `Notes prompt for "${type.name}" must embed its type-specific template`
    );
  }
});

test("every built-in type has keyword rules", async () => {
  const Database = requireSqlite();
  const { seedMeetingTypes } = await import("../../src/helpers/meetingTypesData.js");
  const db = createTestDb(Database);
  seedMeetingTypes(db);

  const types = db.prepare("SELECT name, keyword_rules FROM meeting_types WHERE is_builtin = 1").all();
  for (const t of types) {
    const rules = JSON.parse(t.keyword_rules);
    assert.ok(rules.length > 0, `Built-in "${t.name}" must have at least one keyword rule`);
  }
});
