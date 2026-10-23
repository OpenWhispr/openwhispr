const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("a new skill row defaults to on and keeps its name unique", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("meeting-prep", { contentHash: "h1" });
  db.upsertSkillState("meeting-prep", { contentHash: "h1" });
  db.upsertSkillState("dropped-in", { enabled: false, contentHash: "h2" });

  const states = db.getSkillStates();
  assert.deepEqual(
    states.map(({ name, enabled, contentHash, lastUsedAt }) => [
      name,
      enabled,
      contentHash,
      lastUsedAt,
    ]),
    [
      ["dropped-in", false, "h2", null],
      ["meeting-prep", true, "h1", null],
    ]
  );
  assert.match(states[0].createdAt, ISO);
  assert.match(states[0].updatedAt, ISO);
  assert.throws(
    () => db.db.prepare("INSERT INTO skills (name) VALUES (?)").run("meeting-prep"),
    /UNIQUE/
  );
});

test("a changed hash stamps updated_at and an unchanged one doesn't", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("recap", { contentHash: "h1" });
  db.db.prepare("UPDATE skills SET updated_at = '2026-01-01 00:00:00' WHERE name = ?").run("recap");

  db.upsertSkillState("recap", { contentHash: "h1", enabled: false });
  let [row] = db.getSkillStates();
  assert.deepEqual([row.updatedAt, row.enabled], ["2026-01-01T00:00:00.000Z", false]);

  db.upsertSkillState("recap", { contentHash: "h2" });
  [row] = db.getSkillStates();
  assert.notEqual(row.updatedAt, "2026-01-01T00:00:00.000Z");
  // A state the call doesn't name keeps its value
  assert.deepEqual([row.contentHash, row.enabled], ["h2", false]);
});

test("switching a skill reports whether it has a record", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("recap", { contentHash: "h1" });
  assert.equal(db.setSkillEnabled("recap", false), true);
  assert.equal(db.getSkillStates()[0].enabled, false);
  assert.equal(db.setSkillEnabled("missing", true), false);
});

test("marking a skill used stamps last_used_at", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("recap", { contentHash: "h1" });
  assert.equal(db.getSkillStates()[0].lastUsedAt, null);
  db.markSkillUsed("recap");
  assert.match(db.getSkillStates()[0].lastUsedAt, ISO);
});

test("deleting a skill's state removes only its row", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("keep", { contentHash: "h1" });
  db.upsertSkillState("remove", { contentHash: "h2" });
  db.deleteSkillState("remove");
  assert.deepEqual(
    db.getSkillStates().map((state) => state.name),
    ["keep"]
  );
});
