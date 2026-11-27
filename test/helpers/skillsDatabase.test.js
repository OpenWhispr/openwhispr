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

test("a change stamps updated_at and a repeat doesn't", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("recap", { contentHash: "h1", enabled: false });
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

// ---- Cloud backup state ----

const syncRow = (db, name) =>
  db.db
    .prepare(
      "SELECT name, enabled, cloud_id, client_skill_id, sync_status, deleted_at FROM skills " +
        "WHERE name = ?"
    )
    .get(name);
const pendingNames = (db) => db.getPendingSkills().map((row) => row.name);

test("a local write marks the skill pending", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("recap", { contentHash: "h1" });
  assert.equal(syncRow(db, "recap").sync_status, "pending");
  assert.match(syncRow(db, "recap").client_skill_id, /^[0-9a-f-]{36}$/);

  db.markSkillSynced("recap", "cloud-1", "2026-10-21T09:00:00.000Z", "h1", true);
  assert.deepEqual(pendingNames(db), []);

  db.upsertSkillState("recap", { contentHash: "h1" });
  db.markSkillUsed("recap");
  assert.deepEqual(pendingNames(db), [], "nothing changed, so nothing to send");

  db.setSkillEnabled("recap", false);
  assert.deepEqual(pendingNames(db), ["recap"]);
  db.markSkillSynced("recap", "cloud-1", null, "h1", false);

  db.upsertSkillState("recap", { contentHash: "h2" });
  assert.deepEqual(pendingNames(db), ["recap"]);
});

test("an edit that lands during a push stays pending", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("recap", { contentHash: "h1" });
  db.upsertSkillState("recap", { contentHash: "h2" });

  assert.equal(db.markSkillSynced("recap", "cloud-1", null, "h1", true).changes, 0);
  assert.equal(db.markSkillSynced("recap", "cloud-1", null, "h2", false).changes, 0);
  assert.deepEqual(pendingNames(db), ["recap"]);
  assert.equal(syncRow(db, "recap").cloud_id, "cloud-1", "the edit is sent as an update next");
  assert.equal(db.markSkillSynced("recap", "cloud-1", null, "h2", true).changes, 1);
  assert.equal(syncRow(db, "recap").cloud_id, "cloud-1");
});

test("uninstalling a synced skill leaves a tombstone until its delete is pushed", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("synced", { contentHash: "h1" });
  db.markSkillSynced("synced", "cloud-1", null, "h1", true);
  db.upsertSkillState("local-only", { contentHash: "h2" });

  db.deleteSkillState("synced");
  db.deleteSkillState("local-only");

  assert.deepEqual(
    db.getSkillStates().map((state) => state.name),
    []
  );
  assert.equal(syncRow(db, "local-only"), undefined);
  assert.deepEqual(
    db.getPendingSkillDeletes().map((row) => [row.name, row.cloud_id]),
    [["synced", "cloud-1"]]
  );
  assert.deepEqual(pendingNames(db), []);

  db.hardDeleteSkillState("synced");
  assert.equal(syncRow(db, "synced"), undefined);
  assert.deepEqual(db.getPendingSkillDeletes(), []);
});

test("reinstalling a tombstoned name revives the row", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertSkillState("recap", { contentHash: "h1", enabled: false });
  db.markSkillSynced("recap", "cloud-1", null, "h1", false);
  db.deleteSkillState("recap");

  db.upsertSkillState("recap", { contentHash: "h2", enabled: true });
  // A delete pushed after the revive must not remove the skill.
  db.hardDeleteSkillState("recap");

  const row = syncRow(db, "recap");
  assert.deepEqual(
    [row.deleted_at, row.sync_status, row.cloud_id, row.enabled],
    [null, "pending", null, 1]
  );
  assert.deepEqual(db.getPendingSkillDeletes(), []);
  assert.deepEqual(pendingNames(db), ["recap"]);
});

test("a late upload acknowledgement can queue a durable delete without replacing a reinstall", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.queueSkillCloudDelete("recap", "cloud-1");
  assert.deepEqual(
    db.getPendingSkillDeletes().map((row) => [row.name, row.cloud_id]),
    [["recap", "cloud-1"]]
  );
  assert.deepEqual(db.getSkillStates(), []);
  db.upsertSkillState("recap", { contentHash: "new-copy" });
  assert.equal(db.queueSkillCloudDelete("recap", "cloud-1").success, false);
  assert.deepEqual(db.getPendingSkillDeletes(), []);
  assert.deepEqual(pendingNames(db), ["recap"]);
});

test("a skill from the cloud is stored as synced, and its tombstone as a synced tombstone", (t) => {
  const db = createDb(t);
  if (!db) return;
  const cloud = {
    id: "cloud-9",
    client_skill_id: "other-device",
    name: "recap",
    enabled: false,
    deleted_at: null,
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-21T09:00:00.000Z",
  };

  db.upsertSkillStateFromCloud(cloud, "h9");
  assert.deepEqual(syncRow(db, "recap"), {
    name: "recap",
    enabled: 0,
    cloud_id: "cloud-9",
    client_skill_id: "other-device",
    sync_status: "synced",
    deleted_at: null,
  });
  assert.equal(db.getSkillStates()[0].contentHash, "h9");
  assert.equal(db.getSkillForCloudMerge({ id: "cloud-9" }).name, "recap");
  assert.equal(db.getSkillForCloudMerge({ client_skill_id: "other-device" }).name, "recap");
  assert.equal(db.getSkillForCloudMerge({ name: "recap" }).cloud_id, "cloud-9");

  db.upsertSkillStateFromCloud({ ...cloud, deleted_at: "2026-10-21T10:00:00.000Z" }, null);
  assert.deepEqual(db.getSkillStates(), []);
  assert.deepEqual(db.getPendingSkillDeletes(), []);
  assert.equal(syncRow(db, "recap").sync_status, "synced");
});

test("skills from the cloud and from this computer list newest first together", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.upsertSkillStateFromCloud(
    {
      id: "c1",
      client_skill_id: "other",
      name: "pulled",
      enabled: true,
      deleted_at: null,
      created_at: "2026-10-21T08:00:00.000Z",
      updated_at: "2026-10-21T08:00:00.000Z",
    },
    "h1"
  );
  db.upsertSkillState("made-here", { contentHash: "h2" });
  db.db
    .prepare("UPDATE skills SET created_at = ? WHERE name = ?")
    .run("2026-10-21 09:00:00", "made-here");

  assert.deepEqual(
    db.getSkillStates().map((state) => state.name),
    ["made-here", "pulled"]
  );
});

test("a local change is stamped to the millisecond", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.upsertSkillState("recap", { contentHash: "h1" });
  db.upsertSkillState("recap", { contentHash: "h2" });

  const row = db.db.prepare("SELECT updated_at FROM skills WHERE name = 'recap'").get();
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});
