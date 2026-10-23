const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDb } = require("../harness/db.js");
const debugLogger = require("../../../src/helpers/debugLogger");
const { contentHash } = require("../../../src/helpers/skills/skillFormat");
const { SkillLibrary } = require("../../../src/helpers/skills/skillLibrary");
const { RECOMMENDED_DIR, skillText, writeFolder, listDir, readSkill } = require("./libraryFixture");

// A library over the real DatabaseManager, since sync state lives in its skills table.
function setup(t) {
  const database = createDb(t);
  if (!database) return null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-skill-sync-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const library = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
  return {
    library,
    database,
    skillsDir: path.join(userDataDir, "skills"),
    versionsDir: path.join(userDataDir, "skill-versions"),
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
const cloudSkill = (name, files, extra = {}) => ({
  id: `cloud-${name}`,
  client_skill_id: `client-${name}`,
  name,
  enabled: true,
  content_hash: "from-the-server",
  files,
  deleted_at: null,
  created_at: "2026-10-01T09:00:00.000Z",
  updated_at: "2026-10-21T09:00:00.000Z",
  ...extra,
});
const utf8 = (filePath, content) => ({ path: filePath, encoding: "utf8", content });

test("a skill exports byte for byte: text as UTF-8, everything else as base64", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const markdown = "﻿---\r\nname: crm-export\r\ndescription: Exports.\r\n---\r\nRun it.\r\n";
  writeFolder(ctx.skillsDir, "crm-export", {
    "SKILL.md": markdown,
    "assets/logo.png": PNG,
    "references/notes.md": "Ünïcödé\n",
  });
  ctx.library.scan();

  const exported = ctx.library.exportForCloud("crm-export");

  assert.deepEqual(exported.files, [
    utf8("SKILL.md", markdown),
    { path: "assets/logo.png", encoding: "base64", content: PNG.toString("base64") },
    utf8("references/notes.md", "Ünïcödé\n"),
  ]);
  assert.equal(
    exported.contentHash,
    contentHash([
      { path: "SKILL.md", data: Buffer.from(markdown) },
      { path: "assets/logo.png", data: PNG },
      { path: "references/notes.md", data: Buffer.from("Ünïcödé\n") },
    ])
  );

  const other = setup(t);
  assert.equal(other.library.applyFromCloud(cloudSkill("crm-export", exported.files)), true);
  assert.deepEqual(
    fs.readFileSync(path.join(other.skillsDir, "crm-export", "assets", "logo.png")),
    PNG
  );
  assert.equal(readSkill(other.skillsDir, "crm-export"), markdown);
  assert.equal(other.database.getSkillStates()[0].contentHash, exported.contentHash);
});

test("text that JSON would inflate crosses as base64", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const controls = Buffer.alloc(600_000, 0x01);
  writeFolder(ctx.skillsDir, "controls", {
    "SKILL.md": skillText("controls"),
    "references/log.txt": controls,
  });
  ctx.library.scan();

  const exported = ctx.library.exportForCloud("controls");

  const log = exported.files.find((file) => file.path === "references/log.txt");
  assert.deepEqual(log, {
    path: "references/log.txt",
    encoding: "base64",
    content: controls.toString("base64"),
  });
  assert.equal(exported.files.find((file) => file.path === "SKILL.md").encoding, "utf8");
  assert.ok(Buffer.byteLength(JSON.stringify(exported.files)) < 2 * 1024 * 1024);
});

test("a text file with a NUL byte anywhere crosses as base64", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const lateNul = Buffer.concat([Buffer.from("a".repeat(9000)), Buffer.from([0])]);
  writeFolder(ctx.skillsDir, "late-nul", {
    "SKILL.md": skillText("late-nul"),
    "references/notes.md": lateNul,
  });
  ctx.library.scan();

  const notes = ctx.library
    .exportForCloud("late-nul")
    .files.find((file) => file.path === "references/notes.md");

  assert.equal(notes.encoding, "base64");
  assert.deepEqual(Buffer.from(notes.content, "base64"), lateNul);
});

test("a skill that needs fixing, or isn't there, is not exported", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  writeFolder(ctx.skillsDir, "broken", { "SKILL.md": "no header" });
  ctx.library.scan();

  assert.equal(ctx.library.exportForCloud("broken"), null);
  assert.equal(ctx.library.exportForCloud("missing"), null);
});

test("a skill with a path the cloud can't store is not exported", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  writeFolder(ctx.skillsDir, "odd-path", {
    "SKILL.md": skillText("odd-path"),
    "references/a\\b.md": "x",
  });
  writeFolder(ctx.skillsDir, "long-path", {
    "SKILL.md": skillText("long-path"),
    [`references/${"d/".repeat(260)}a.md`]: "x",
  });
  ctx.library.scan();

  assert.equal(ctx.library.exportForCloud("odd-path"), null);
  assert.equal(ctx.library.exportForCloud("long-path"), null);
});

test("a skill folder that is a link is never exported", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "SKILL.md"), skillText("linked"));
  fs.mkdirSync(ctx.skillsDir, { recursive: true });
  fs.symlinkSync(outside, path.join(ctx.skillsDir, "linked"), "dir");

  assert.equal(ctx.library.exportForCloud("linked"), null);
});

test("a skill over the sync caps reports tooLargeToSync and is never pushed", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  writeFolder(ctx.skillsDir, "big-one", {
    "SKILL.md": skillText("big-one"),
    "references/big.md": "x".repeat(1024 * 1024),
  });
  const many = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`references/${index}.md`, "x"])
  );
  writeFolder(ctx.skillsDir, "many-files", { "SKILL.md": skillText("many-files"), ...many });
  writeFolder(ctx.skillsDir, "small-one", { "SKILL.md": skillText("small-one") });

  const summaries = Object.fromEntries(ctx.library.scan().map((skill) => [skill.name, skill]));

  assert.equal(summaries["big-one"].tooLargeToSync, true);
  assert.equal(summaries["many-files"].tooLargeToSync, true);
  assert.equal(summaries["small-one"].tooLargeToSync, undefined);
  assert.equal(summaries["big-one"].valid, true, "it still works on this computer");
  assert.deepEqual(ctx.library.exportForCloud("big-one"), { tooLargeToSync: true });
  assert.deepEqual(ctx.library.exportForCloud("many-files"), { tooLargeToSync: true });
});

test("a pulled skill is validated and written atomically; an invalid one is skipped and logged", (
  t
) => {
  const ctx = setup(t);
  if (!ctx) return;
  const warnings = t.mock.method(debugLogger, "warn", () => {});
  writeFolder(ctx.skillsDir, "meeting-prep", { "SKILL.md": skillText("meeting-prep", "Old.") });
  ctx.library.scan();

  const updated = cloudSkill("meeting-prep", [
    utf8("SKILL.md", skillText("meeting-prep", "New.")),
    utf8("references/agenda.md", "Agenda\n"),
  ]);
  assert.equal(ctx.library.applyFromCloud({ ...updated, enabled: false }), true);
  assert.equal(readSkill(ctx.skillsDir, "meeting-prep"), skillText("meeting-prep", "New."));
  assert.deepEqual(listDir(path.join(ctx.skillsDir, "meeting-prep", "references")), [
    "agenda.md",
  ]);
  const [summary] = ctx.library.scan();
  assert.deepEqual([summary.description, summary.enabled], ["New.", false]);

  const refused = [
    cloudSkill("wrong-name", [utf8("SKILL.md", skillText("other-name"))]),
    cloudSkill("no-skill-file", [utf8("README.md", "x")]),
    cloudSkill("climbs-out", [
      utf8("SKILL.md", skillText("climbs-out")),
      utf8("../../evil.md", "x"),
    ]),
    cloudSkill("bad-encoding", [{ path: "SKILL.md", encoding: "hex", content: "00" }]),
    cloudSkill("../outside", [utf8("SKILL.md", skillText("outside"))]),
    cloudSkill("too-big", [
      utf8("SKILL.md", skillText("too-big")),
      utf8("big.md", "x".repeat(1024 * 1024)),
    ]),
    cloudSkill("not-a-list", "SKILL.md"),
  ];
  for (const entry of refused) {
    assert.equal(ctx.library.applyFromCloud(entry), false, entry.name);
  }
  assert.deepEqual(listDir(ctx.skillsDir), ["meeting-prep"], "nothing else was written");
  assert.ok(!fs.existsSync(path.join(ctx.skillsDir, "..", "evil.md")));
  assert.deepEqual(
    ctx.database.getSkillStates().map((state) => state.name),
    ["meeting-prep"]
  );
  assert.equal(warnings.mock.callCount(), refused.length);
});

test("a pulled skill already on disk only takes the cloud's state", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  writeFolder(ctx.skillsDir, "recap", { "SKILL.md": skillText("recap") });
  ctx.library.scan();
  const before = fs.statSync(path.join(ctx.skillsDir, "recap", "SKILL.md")).mtimeMs;

  ctx.library.applyFromCloud(
    cloudSkill("recap", [utf8("SKILL.md", skillText("recap"))], { enabled: false })
  );

  assert.equal(fs.statSync(path.join(ctx.skillsDir, "recap", "SKILL.md")).mtimeMs, before);
  assert.equal(ctx.library.scan()[0].enabled, false);
  assert.deepEqual(ctx.database.getPendingSkills(), []);
});

test("a pulled tombstone removes the folder and its versions", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.library.applyFromCloud(cloudSkill("recap", [utf8("SKILL.md", skillText("recap"))]));
  ctx.library.saveVersion("recap");
  assert.deepEqual(listDir(ctx.versionsDir), ["recap"]);

  const removed = ctx.library.applyFromCloud(
    cloudSkill("recap", [], { deleted_at: "2026-10-21T10:00:00.000Z" })
  );

  assert.equal(removed, true);
  assert.deepEqual(listDir(ctx.skillsDir), []);
  assert.deepEqual(listDir(ctx.versionsDir), []);
  assert.deepEqual(ctx.library.scan(), []);
  assert.deepEqual(ctx.database.getPendingSkillDeletes(), [], "nothing to send back");
});

test("a pulled tombstone also removes an old copy a replace couldn't clear", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.library.applyFromCloud(cloudSkill("recap", [utf8("SKILL.md", skillText("recap"))]));
  // What a replace leaves when its old copy can't be removed: put back at the next start.
  writeFolder(ctx.skillsDir, `.replaced-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}-recap`, {
    "SKILL.md": skillText("recap", "Old.", "Old.\n"),
  });

  ctx.library.applyFromCloud(cloudSkill("recap", [], { deleted_at: "2026-10-21T10:00:00.000Z" }));
  const reopened = new SkillLibrary({
    userDataDir: path.dirname(ctx.skillsDir),
    database: ctx.database,
    recommendedDir: RECOMMENDED_DIR,
  });

  assert.deepEqual(reopened.scan(), []);
});

test("a pulled tombstone applies on a computer with no skills yet", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  assert.equal(fs.existsSync(ctx.skillsDir), false);

  const removed = ctx.library.applyFromCloud(
    cloudSkill("recap", [], { deleted_at: "2026-10-21T10:00:00.000Z" })
  );

  assert.equal(removed, true);
  assert.equal(ctx.database.getSkillForCloudMerge({ name: "recap" }).deleted_at !== null, true);
});

test("uninstalling, or removing a folder by hand, leaves a tombstone for a synced skill", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  for (const name of ["by-app", "by-hand"]) {
    ctx.library.applyFromCloud(cloudSkill(name, [utf8("SKILL.md", skillText(name))]));
  }

  ctx.library.uninstall("by-app");
  fs.rmSync(path.join(ctx.skillsDir, "by-hand"), { recursive: true });
  ctx.library.scan();

  assert.deepEqual(
    ctx.database
      .getPendingSkillDeletes()
      .map((row) => row.name)
      .sort(),
    ["by-app", "by-hand"]
  );
});

// Past the limits a skill can be read at, the library can't tell what is in it, so the
// cloud's copy never replaces or deletes it.
test("a skill over this computer's own limits is never replaced or removed from the cloud", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.library.applyFromCloud(cloudSkill("recap", [utf8("SKILL.md", skillText("recap"))]));
  const extra = Object.fromEntries(
    Array.from({ length: 501 }, (_, index) => [`references/f${index}.md`, `Note ${index}.\n`])
  );
  writeFolder(ctx.skillsDir, "recap", { "SKILL.md": skillText("recap"), ...extra });
  ctx.library.scan();
  const warn = t.mock.method(debugLogger, "warn", () => {});

  const edited = ctx.library.applyFromCloud(
    cloudSkill("recap", [utf8("SKILL.md", skillText("recap", "Cloud.", "Cloud.\n"))], {
      updated_at: "2026-10-22T09:00:00.000Z",
    })
  );
  const deleted = ctx.library.applyFromCloud(
    cloudSkill("recap", [], { deleted_at: "2026-10-22T10:00:00.000Z" })
  );

  assert.deepEqual([edited, deleted], [false, false]);
  assert.equal(listDir(path.join(ctx.skillsDir, "recap", "references")).length, 501);
  assert.equal(readSkill(ctx.skillsDir, "recap"), skillText("recap"));
  assert.ok(warn.mock.calls.length >= 2);
});

// A replace cut short leaves the skill only as its moved-aside copy until the next start
// puts it back; meanwhile it isn't gone, so no removal is sent to the other devices.
test("a skill waiting to be put back after a replace keeps its state", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.library.applyFromCloud(cloudSkill("recap", [utf8("SKILL.md", skillText("recap"))]));
  fs.renameSync(
    path.join(ctx.skillsDir, "recap"),
    path.join(ctx.skillsDir, `.replaced-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}-recap`)
  );

  ctx.library.scan();

  assert.deepEqual(ctx.database.getPendingSkillDeletes(), []);
  assert.equal(ctx.database.getSkillForCloudMerge({ name: "recap" }).deleted_at, null);
});

test("a skill whose files can't be read is never replaced or removed from the cloud", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.library.applyFromCloud(cloudSkill("recap", [utf8("SKILL.md", skillText("recap"))]));
  writeFolder(ctx.skillsDir, "recap", { "notes/mine.md": "Mine.\n" });
  fs.symlinkSync(os.tmpdir(), path.join(ctx.skillsDir, "recap", "linked"));
  ctx.library.scan();
  t.mock.method(debugLogger, "warn", () => {});

  const edited = ctx.library.applyFromCloud(
    cloudSkill("recap", [utf8("SKILL.md", skillText("recap", "Cloud.", "Cloud.\n"))], {
      updated_at: "2026-10-22T09:00:00.000Z",
    })
  );
  const deleted = ctx.library.applyFromCloud(
    cloudSkill("recap", [], { deleted_at: "2026-10-22T10:00:00.000Z" })
  );

  assert.deepEqual([edited, deleted], [false, false]);
  assert.deepEqual(listDir(path.join(ctx.skillsDir, "recap", "notes")), ["mine.md"]);
  assert.ok(fs.lstatSync(path.join(ctx.skillsDir, "recap", "linked")).isSymbolicLink());
});
