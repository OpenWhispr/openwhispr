const test = require("node:test");
const assert = require("node:assert/strict");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") || message.includes("Could not locate the bindings file")
  );
}

function tryRequireSqlite(t) {
  try {
    const Database = require("better-sqlite3");
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

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

test("seedMeetingTypes creates 7 built-in types", async (t) => {
  const Database = tryRequireSqlite(t);
  if (!Database) return;
  const { seedMeetingTypes } = await import("../../src/helpers/meetingTypesData.js");
  const db = createTestDb(Database);
  seedMeetingTypes(db);

  const count = db.prepare("SELECT COUNT(*) as c FROM meeting_types WHERE is_builtin = 1").get();
  assert.equal(count.c, 7);
});

test("seedMeetingTypes is idempotent", async (t) => {
  const Database = tryRequireSqlite(t);
  if (!Database) return;
  const { seedMeetingTypes } = await import("../../src/helpers/meetingTypesData.js");
  const db = createTestDb(Database);
  seedMeetingTypes(db);
  seedMeetingTypes(db);

  const count = db.prepare("SELECT COUNT(*) as c FROM meeting_types").get();
  assert.equal(count.c, 7);
});

test("every built-in template mentions Action Items", async (t) => {
  const Database = tryRequireSqlite(t);
  if (!Database) return;
  const { seedMeetingTypes } = await import("../../src/helpers/meetingTypesData.js");
  const db = createTestDb(Database);
  seedMeetingTypes(db);

  const types = db.prepare("SELECT name, template FROM meeting_types WHERE is_builtin = 1").all();
  for (const t of types) {
    assert.ok(
      t.template.toLowerCase().includes("action item"),
      `Built-in "${t.name}" template must mention Action Items`
    );
  }
});

test("every built-in type has keyword rules", async (t) => {
  const Database = tryRequireSqlite(t);
  if (!Database) return;
  const { seedMeetingTypes } = await import("../../src/helpers/meetingTypesData.js");
  const db = createTestDb(Database);
  seedMeetingTypes(db);

  const types = db.prepare("SELECT name, keyword_rules FROM meeting_types WHERE is_builtin = 1").all();
  for (const t of types) {
    const rules = JSON.parse(t.keyword_rules);
    assert.ok(rules.length > 0, `Built-in "${t.name}" must have at least one keyword rule`);
  }
});
