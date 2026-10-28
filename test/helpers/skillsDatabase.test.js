const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const fs = require("node:fs");
const path = require("node:path");
const { getUserDataDir } = require("./harness/electronStub.js");
const { SkillLibrary } = require("../../src/helpers/skills/skillLibrary.js");

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

test("restoring a skill row puts back nullable state and timestamps without replacing its identity", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.upsertSkillState("restore", { enabled: false });
  db.db
    .prepare(
      "UPDATE skills SET created_at = '2026-01-01 10:00:00', updated_at = '2026-02-02 11:22:33.456' WHERE name = ?"
    )
    .run("restore");
  const [original] = db.getSkillStates();
  const { id } = db.db.prepare("SELECT id FROM skills WHERE name = ?").get("restore");
  db.upsertSkillState("restore", { enabled: true, contentHash: "new-content" });
  db.markSkillUsed("restore");

  db.restoreSkillState("restore", original);

  assert.deepEqual(db.getSkillStates(), [original]);
  assert.equal(db.db.prepare("SELECT id FROM skills WHERE name = ?").get("restore").id, id);
  assert.equal(
    db.db.prepare("SELECT created_at FROM skills WHERE name = ?").get("restore").created_at,
    "2026-01-01 10:00:00"
  );
});

test("restoring a missing skill row preserves its complete saved state", (t) => {
  const db = createDb(t);
  if (!db) return;
  const original = {
    name: "restored",
    enabled: true,
    contentHash: "original-content",
    lastUsedAt: "2026-02-03T10:11:12.345Z",
    createdAt: "2026-01-01T01:02:03.456Z",
    updatedAt: "2026-02-02T11:22:33.789Z",
  };

  db.restoreSkillState(original.name, original);

  assert.deepEqual(db.getSkillStates(), [original]);
});

test("restoring an absent skill state removes only the failed new row", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.upsertSkillState("keep", { contentHash: "original" });
  const original = db.getSkillStates();
  db.upsertSkillState("failed", { contentHash: "uncommitted" });

  db.restoreSkillState("failed", null);
  db.restoreSkillState("never-created", null);

  assert.deepEqual(db.getSkillStates(), original);
});

test("a failed skill state restoration surfaces the database error and preserves the row", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.upsertSkillState("restore", { contentHash: "current" });
  const original = db.getSkillStates();
  db.db.pragma("query_only = ON");

  assert.throws(
    () => db.restoreSkillState("restore", { ...original[0], enabled: false }),
    /readonly/
  );
  assert.deepEqual(db.getSkillStates(), original);
});

test("a read-only database still rolls the skill files back without another database write", async (t) => {
  const database = createDb(t);
  if (!database) return;
  const library = new SkillLibrary({ userDataDir: getUserDataDir(), database });
  library.create({
    title: "Keep",
    description: "Old",
    instructions: "Original instructions",
    files: [],
  });
  library.setEnabled("keep", false);
  const file = path.join(library.skillsDir, "keep", "SKILL.md");
  const original = fs.readFileSync(file, "utf8");
  const state = database.getSkillStates();
  const [preview] = await library.previewUploads([
    {
      fileName: "keep.md",
      data: Buffer.from("---\nname: keep\ndescription: New\n---\nReplacement\n"),
    },
  ]);
  database.db.pragma("query_only = ON");
  const result = library.commitUploads({ tokens: [preview.token], replace: ["keep"] });
  assert.equal(result.failed.length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(database.getSkillStates(), state);
  assert.deepEqual(fs.readdirSync(library.skillsDir), ["keep"]);
  database.db.pragma("query_only = OFF");
  assert.deepEqual(library.commitUploads({ tokens: [preview.token], replace: ["keep"] }), {
    installed: ["keep"],
    failed: [],
  });
  assert.equal(library.get("keep").enabled, false);
});

test("a failed replacement marker restores the original database row before scanning", async (t) => {
  const database = createDb(t);
  if (!database) return;
  const library = new SkillLibrary({ userDataDir: getUserDataDir(), database });
  library.create({ title: "Keep", description: "Old", instructions: "Original", files: [] });
  library.setEnabled("keep", false);
  database.markSkillUsed("keep");
  database.db.prepare("UPDATE skills SET updated_at = '2000-01-01 00:00:00'").run();
  const original = database.db.prepare("SELECT * FROM skills").all();
  const markdown = fs.readFileSync(path.join(library.skillsDir, "keep", "SKILL.md"), "utf8");
  const [preview] = await library.previewUploads([
    {
      fileName: "keep.md",
      data: Buffer.from("---\nname: keep\ndescription: New\n---\nReplacement\n"),
    },
  ]);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (
      path.basename(from).startsWith(".replacing-") &&
      path.basename(to).startsWith(".replaced-")
    ) {
      throw Object.assign(new Error("marker locked"), { code: "EACCES" });
    }
    return rename(from, to);
  });
  assert.equal(
    library.commitUploads({ tokens: [preview.token], replace: ["keep"] }).failed.length,
    1
  );
  t.mock.restoreAll();
  assert.deepEqual(database.db.prepare("SELECT * FROM skills").all(), original);
  assert.equal(fs.readFileSync(path.join(library.skillsDir, "keep", "SKILL.md"), "utf8"), markdown);
  assert.equal(library.get("keep").enabled, false);
});
