const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { installElectronStub } = require("../harness/electronStub.js");

installElectronStub();
const { SkillLibrary } = require("../../../src/helpers/skills/skillLibrary");
const { SKILL_LIMITS, parseSkillMarkdown } = require("../../../src/helpers/skills/skillFormat");
const { buildZip } = require("./zipFixture");

const RECOMMENDED_DIR = path.join(__dirname, "../../../src/helpers/skills/recommended");

const skillText = (name, description = "Does it.", body = "Steps\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

// The five state methods of DatabaseManager, kept in memory so these tests run under any
// Node. test/helpers/skillsDatabase.test.js pins the real ones to the same contract.
function fakeDatabase() {
  const rows = new Map();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 20, 9, 0, tick++)).toISOString();
  return {
    rows,
    getSkillStates: () => [...rows.values()].reverse().map((row) => ({ ...row })),
    upsertSkillState(name, { enabled, contentHash } = {}) {
      const row = rows.get(name);
      if (!row) {
        const at = now();
        rows.set(name, {
          name,
          enabled: enabled ?? true,
          contentHash: contentHash ?? null,
          lastUsedAt: null,
          createdAt: at,
          updatedAt: at,
        });
        return;
      }
      if (enabled !== undefined) row.enabled = enabled;
      if (contentHash !== undefined && contentHash !== row.contentHash) {
        row.contentHash = contentHash;
        row.updatedAt = now();
      }
    },
    setSkillEnabled(name, enabled) {
      const row = rows.get(name);
      if (!row) return false;
      row.enabled = enabled;
      return true;
    },
    markSkillUsed(name) {
      const row = rows.get(name);
      if (row) row.lastUsedAt = now();
    },
    deleteSkillState(name) {
      rows.delete(name);
    },
  };
}

function setup(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-skill-library-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const database = fakeDatabase();
  const library = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
  return { library, database, userDataDir, skillsDir: path.join(userDataDir, "skills") };
}

function writeFolder(skillsDir, name, files) {
  for (const [relPath, data] of Object.entries(files)) {
    const filePath = path.join(skillsDir, name, ...relPath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  }
}

const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const readSkill = (skillsDir, name) =>
  fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");

async function upload(library, items, replace = []) {
  const previews = await library.previewUploads(items);
  const tokens = previews.filter((preview) => preview.token).map((preview) => preview.token);
  return { previews, result: library.commitUploads({ tokens, replace }) };
}

const markdownUpload = (fileName, text) => ({ fileName, data: Buffer.from(text) });

test("an upload is stored byte for byte, unknown keys and extra files included", async (t) => {
  const { library, skillsDir } = setup(t);
  const files = {
    "SKILL.md":
      "---\r\nname: crm-export\r\ndescription: Exports the CRM.\r\nwhen_to_use: Fridays\r\n" +
      'metadata:\r\n  display_name: "CRM export"\r\n  version: "2"\r\n---\r\n\r\nRun it.\r\n',
    "agents/openai.yaml": "interface:\n  display_name: CRM export\n",
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]),
  };
  const zip = buildZip(
    Object.entries(files).map(([relPath, data]) => ({
      path: `crm-export/${relPath}`,
      data,
      deflate: true,
    }))
  );

  const { previews, result } = await upload(library, [{ fileName: "crm-export.zip", data: zip }]);

  assert.equal(previews[0].status, "ready");
  assert.deepEqual(
    previews[0].warnings.map((warning) => warning.code),
    ["unknownKeys"]
  );
  assert.deepEqual(result, { installed: ["crm-export"], failed: [] });
  for (const [relPath, data] of Object.entries(files)) {
    const stored = fs.readFileSync(path.join(skillsDir, "crm-export", ...relPath.split("/")));
    assert.ok(stored.equals(Buffer.from(data)), relPath);
  }
  assert.deepEqual(listDir(path.join(skillsDir, "crm-export")), ["SKILL.md", "agents", "assets"]);
});

test("a bare .md is stored unchanged as <name>/SKILL.md", async (t) => {
  const { library, skillsDir } = setup(t);
  const text = "\uFEFF---\nname: weekly-recap\ndescription: Writes my recap.\n---\n\nSteps\n";

  const { previews, result } = await upload(library, [markdownUpload("My recap.md", text)]);

  assert.deepEqual([previews[0].name, previews[0].displayName], ["weekly-recap", "Weekly recap"]);
  assert.deepEqual(result.installed, ["weekly-recap"]);
  const stored = fs.readFileSync(path.join(skillsDir, "weekly-recap", "SKILL.md"));
  assert.ok(stored.equals(Buffer.from(text)));
  assert.deepEqual(listDir(path.join(skillsDir, "weekly-recap")), ["SKILL.md"]);
});

test("a folder renamed to match the name gets the folderRenamed warning", async (t) => {
  const { library, skillsDir } = setup(t);
  const zip = buildZip([{ path: "Downloads copy/SKILL.md", data: skillText("meeting-prep") }]);

  const { previews, result } = await upload(library, [{ fileName: "prep.skill", data: zip }]);

  assert.deepEqual(
    previews[0].warnings.map((warning) => warning.code),
    ["folderRenamed"]
  );
  assert.deepEqual(result.installed, ["meeting-prep"]);
  assert.deepEqual(listDir(skillsDir), ["meeting-prep"]);
});

test("Copy markdown returns the stored bytes exactly", async (t) => {
  const { library } = setup(t);
  const text =
    "\uFEFF---\r\nname: recap\r\ndescription: Recaps.\r\nextra: kept\r\n---\r\n\r\nGo\r\n";
  await upload(library, [markdownUpload("recap.md", text)]);

  assert.equal(library.get("recap").markdown, text);
});

test("a skill found on disk with no record starts off", (t) => {
  const { library, skillsDir } = setup(t);
  writeFolder(skillsDir, "dropped-in", { "SKILL.md": skillText("dropped-in") });

  const [skill] = library.scan();

  assert.deepEqual([skill.name, skill.enabled, skill.valid], ["dropped-in", false, true]);
});

test("created, uploaded and added skills start on, newest first", async (t) => {
  const { library } = setup(t);
  await upload(library, [markdownUpload("a.md", skillText("uploaded-one"))]);
  library.create({ title: "Made here", description: "Does it.", instructions: "Go", files: [] });
  library.addRecommended("meeting-decisions", { title: "Meeting decisions", description: "Keeps them." });

  assert.deepEqual(
    library.scan().map((skill) => [skill.name, skill.enabled, skill.valid]),
    [
      ["meeting-decisions", true, true],
      ["made-here", true, true],
      ["uploaded-one", true, true],
    ]
  );
});

test(
  "a skill broken outside the app is listed with its problem and can't be turned on",
  async (t) => {
    const { library, skillsDir } = setup(t);
    await upload(library, [markdownUpload("prep.md", skillText("meeting-prep"))]);
    fs.writeFileSync(
      path.join(skillsDir, "meeting-prep", "SKILL.md"),
      '---\nname: meeting-prep\ndescription: ""\n---\n\nSteps\n'
    );

    const [skill] = library.scan();

    assert.deepEqual(
      [skill.valid, skill.problem, skill.enabled],
      [false, { code: "missingDescription" }, true]
    );
    assert.equal(library.setEnabled("meeting-prep", false), true);
    assert.equal(library.setEnabled("meeting-prep", true), false);
    assert.equal(library.scan()[0].enabled, false);
  }
);

test("a renamed name field shows a mismatch", async (t) => {
  const { library, skillsDir } = setup(t);
  await upload(library, [markdownUpload("prep.md", skillText("meeting-prep"))]);
  fs.writeFileSync(
    path.join(skillsDir, "meeting-prep", "SKILL.md"),
    skillText("prep-for-meetings")
  );

  const [skill] = library.scan();

  assert.deepEqual(
    [skill.name, skill.valid, skill.problem],
    ["meeting-prep", false, { code: "nameMismatch" }]
  );
});

test("fixing it outside the app brings it back on the next scan", async (t) => {
  const { library, skillsDir } = setup(t);
  await upload(library, [markdownUpload("prep.md", skillText("meeting-prep"))]);
  const skillFile = path.join(skillsDir, "meeting-prep", "SKILL.md");
  fs.writeFileSync(skillFile, "# No header any more\n");
  assert.equal(library.scan()[0].valid, false);

  fs.writeFileSync(skillFile, skillText("meeting-prep", "Briefs me before meetings."));
  const [skill] = library.scan();

  assert.deepEqual(
    [skill.valid, skill.problem, skill.enabled, skill.description],
    [true, undefined, true, "Briefs me before meetings."]
  );
});

test("a skill folder removed outside the app drops its record", async (t) => {
  const { library, database, skillsDir } = setup(t);
  await upload(library, [markdownUpload("gone.md", skillText("gone"))]);
  fs.rmSync(path.join(skillsDir, "gone"), { recursive: true });

  assert.deepEqual(library.scan(), []);
  assert.equal(database.rows.has("gone"), false);
});

test(
  "a duplicate upload offers replace; replace swaps the folder, and without it the folder stays",
  async (t) => {
    const { library, skillsDir } = setup(t);
    await upload(library, [markdownUpload("a.md", skillText("dup", "First."))]);
    const second = markdownUpload("b.md", skillText("dup", "Second."));

    const [kept] = await library.previewUploads([second]);
    assert.equal(kept.status, "duplicate");
    assert.deepEqual(library.commitUploads({ tokens: [kept.token], replace: [] }), {
      installed: [],
      failed: [{ fileName: "b.md", error: "exists" }],
    });
    assert.match(readSkill(skillsDir, "dup"), /First\./);

    const [replaced] = await library.previewUploads([second]);
    assert.deepEqual(library.commitUploads({ tokens: [replaced.token], replace: ["dup"] }), {
      installed: ["dup"],
      failed: [],
    });
    assert.match(readSkill(skillsDir, "dup"), /Second\./);
    assert.deepEqual(listDir(skillsDir), ["dup"]);
  }
);

test("the same skill twice in one upload is a duplicate the second time", async (t) => {
  const { library } = setup(t);

  const previews = await library.previewUploads([
    markdownUpload("one.md", skillText("twice", "One.")),
    markdownUpload("two.md", skillText("twice", "Two.")),
  ]);

  assert.deepEqual(
    previews.map((preview) => preview.status),
    ["ready", "duplicate"]
  );
});

test("an upload token installs exactly what was previewed, once", async (t) => {
  const { library, skillsDir } = setup(t);
  const data = Buffer.from(skillText("once"));
  const original = Buffer.from(data);
  const [preview] = await library.previewUploads([{ fileName: "once.md", data }]);
  data.fill(0x78);

  assert.deepEqual(library.commitUploads({ tokens: [preview.token], replace: [] }), {
    installed: ["once"],
    failed: [],
  });
  assert.ok(fs.readFileSync(path.join(skillsDir, "once", "SKILL.md")).equals(original));

  const again = library.commitUploads({ tokens: [preview.token], replace: ["once"] });
  assert.deepEqual(again.installed, []);
  assert.equal(again.failed.length, 1);
});

test("one skill uploaded twice, the second replacing the first, is listed once", async (t) => {
  const { library, skillsDir } = setup(t);
  const preview = async (fileName, description) =>
    (await library.previewUploads([markdownUpload(fileName, skillText("weekly", description))]))[0];
  const first = await preview("v1.md", "First.");
  const second = await preview("v2.md", "Second.");

  assert.deepEqual(
    library.commitUploads({ tokens: [first.token, second.token], replace: ["weekly"] }),
    { installed: ["weekly"], failed: [] }
  );
  assert.match(readSkill(skillsDir, "weekly"), /description: Second\./);
});

test("a window's uploads are let go when it goes away, and no other window's", async (t) => {
  const { library } = setup(t);
  const [kept] = await library.previewUploads([markdownUpload("kept.md", skillText("kept"))], 1);
  const [gone] = await library.previewUploads([markdownUpload("gone.md", skillText("gone"))], 2);

  library.discardUploadsFrom(2);
  const result = library.commitUploads({ tokens: [kept.token, gone.token], replace: [] });

  assert.deepEqual(result.installed, ["kept"]);
  assert.equal(result.failed.length, 1);
});

test("Replace keeps the skill's switch as it was", async (t) => {
  const { library } = setup(t);
  await upload(library, [markdownUpload("off.md", skillText("off", "Old."))]);
  await upload(library, [markdownUpload("on.md", skillText("on", "Old."))]);
  library.setEnabled("off", false);

  await upload(
    library,
    [
      markdownUpload("off-2.md", skillText("off", "New.")),
      markdownUpload("on-2.md", skillText("on", "New.")),
    ],
    ["off", "on"]
  );

  assert.deepEqual(
    library.scan().map((skill) => [skill.name, skill.enabled, skill.description]),
    [
      ["on", true, "New."],
      ["off", false, "New."],
    ]
  );
});

test("an upload stays ready until it is installed or discarded", async (t) => {
  const { library, skillsDir } = setup(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 20, 9, 0, 0) });
  const preview = async (fileName, name) =>
    (await library.previewUploads([markdownUpload(fileName, skillText(name))]))[0];
  const kept = await preview("kept.md", "kept");
  const dropped = await preview("dropped.md", "dropped");

  t.mock.timers.tick(24 * 60 * 60 * 1000);
  library.discardUploads([dropped.token]);
  const result = library.commitUploads({ tokens: [kept.token, dropped.token], replace: [] });

  assert.deepEqual(result.installed, ["kept"]);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(listDir(skillsDir), ["kept"]);
});

test(
  "uploads that aren't skills are refused with a reason, and the rest still preview",
  async (t) => {
    const { library } = setup(t);

    const previews = await library.previewUploads([
      markdownUpload("notes.txt", "plain text"),
      { fileName: "huge.zip", data: Buffer.alloc(SKILL_LIMITS.maxBytes + 1) },
      markdownUpload("no-header.md", "# Title\n"),
      markdownUpload("FINE.MD", skillText("fine")),
    ]);

    assert.deepEqual(
      previews.map((preview) => [
        preview.fileName,
        preview.status,
        preview.problems.map((problem) => problem.code),
      ]),
      [
        ["notes.txt", "invalid", ["unsupportedFile"]],
        ["huge.zip", "invalid", ["tooLarge"]],
        ["no-header.md", "invalid", ["frontmatterMissing"]],
        ["FINE.MD", "ready", []],
      ]
    );
    assert.equal(previews[0].token, undefined);
  }
);

test("a file whose preview throws is refused alone, and the rest still preview", async (t) => {
  const { library } = setup(t);
  const previewOne = library._previewUpload.bind(library);
  t.mock.method(library, "_previewUpload", (item, batchNames) => {
    if (item.fileName === "broken.zip") throw new RangeError("out of range");
    return previewOne(item, batchNames);
  });

  const previews = await library.previewUploads([
    markdownUpload("first.md", skillText("first")),
    { fileName: "broken.zip", data: Buffer.from("PK") },
    markdownUpload("last.md", skillText("last")),
  ]);

  assert.deepEqual(
    previews.map((preview) => [
      preview.fileName,
      preview.status,
      preview.problems.map((problem) => problem.code),
    ]),
    [
      ["first.md", "ready", []],
      ["broken.zip", "invalid", ["unreadableArchive"]],
      ["last.md", "ready", []],
    ]
  );
});

test("a failed write leaves the old skill and no staging folder", async (t) => {
  const { library, skillsDir } = setup(t);
  await upload(library, [markdownUpload("a.md", skillText("keep", "Old."))]);
  const newer = markdownUpload("b.md", skillText("keep", "New."));
  const [preview] = await library.previewUploads([newer]);
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });

  const result = library.commitUploads({ tokens: [preview.token], replace: ["keep"] });
  assert.throws(
    () => library.create({ title: "Other", description: "x", instructions: "y", files: [] }),
    { code: "noSpace" }
  );
  t.mock.restoreAll();

  assert.deepEqual(result, { installed: [], failed: [{ fileName: "b.md", error: "noSpace" }] });
  assert.match(readSkill(skillsDir, "keep"), /Old\./);
  assert.deepEqual(listDir(skillsDir), ["keep"]);
});

test("an upload that fails for a reason the app can't name reports it as unknown", async (t) => {
  const { library, database } = setup(t);
  const [preview] = await library.previewUploads([markdownUpload("a.md", skillText("weekly"))]);
  t.mock.method(database, "upsertSkillState", () => {
    throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
  });

  const result = library.commitUploads({ tokens: [preview.token], replace: [] });

  assert.deepEqual(result, { installed: [], failed: [{ fileName: "a.md", error: "unknown" }] });
});

test("an upload whose skill appeared after its preview is reported, not dropped", async (t) => {
  const { library, skillsDir } = setup(t);
  // The second is previewed as a copy of the first, and is sent alone once that one is removed.
  const [first, copy] = await library.previewUploads([
    markdownUpload("a.md", skillText("weekly")),
    markdownUpload("b.md", skillText("weekly")),
  ]);
  writeFolder(skillsDir, "weekly", { "SKILL.md": skillText("weekly", "Made meanwhile.") });

  for (const [preview, fileName] of [
    [first, "a.md"],
    [copy, "b.md"],
  ]) {
    const result = library.commitUploads({ tokens: [preview.token], replace: [] });
    assert.deepEqual(result, { installed: [], failed: [{ fileName, error: "exists" }] });
  }
  assert.match(readSkill(skillsDir, "weekly"), /Made meanwhile\./);
  // The upload is kept, so choosing Replace sends the same one again.
  assert.deepEqual(library.commitUploads({ tokens: [copy.token], replace: ["weekly"] }), {
    installed: ["weekly"],
    failed: [],
  });
});

test("a failed write keeps the upload, so it can be tried again", async (t) => {
  const { library, skillsDir } = setup(t);
  const [preview] = await library.previewUploads([markdownUpload("retry.md", skillText("retry"))]);
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });
  const failed = library.commitUploads({ tokens: [preview.token], replace: [] });
  t.mock.restoreAll();

  const retried = library.commitUploads({ tokens: [preview.token], replace: [] });

  assert.deepEqual(failed, { installed: [], failed: [{ fileName: "retry.md", error: "noSpace" }] });
  assert.deepEqual(retried, { installed: ["retry"], failed: [] });
  assert.deepEqual(listDir(skillsDir), ["retry"]);
});

test("a failed swap puts the old skill back", async (t) => {
  const { library, skillsDir } = setup(t);
  await upload(library, [markdownUpload("a.md", skillText("keep", "Old."))]);
  const newer = markdownUpload("b.md", skillText("keep", "New."));
  const [preview] = await library.previewUploads([newer]);
  const realRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (path.basename(from).startsWith(".staging-")) {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return realRename(from, to);
  });

  const result = library.commitUploads({ tokens: [preview.token], replace: ["keep"] });
  t.mock.restoreAll();

  assert.deepEqual(result.failed, [{ fileName: "b.md", error: "permission" }]);
  assert.match(readSkill(skillsDir, "keep"), /Old\./);
  assert.deepEqual(listDir(skillsDir), ["keep"]);
});

// Antivirus and the search indexer can hold a file Windows just saw written for a moment.
function onPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  t.after(() => Object.defineProperty(process, "platform", original));
}

function renamesRefusedTwice(t, code) {
  const realRename = fs.renameSync;
  let refused = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (refused < 2) {
      refused += 1;
      throw Object.assign(new Error("busy"), { code });
    }
    return realRename(from, to);
  });
}

test("on Windows, a rename refused for a moment is tried again", async (t) => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const { library, skillsDir } = setup(t);
    const [preview] = await library.previewUploads([markdownUpload("a.md", skillText("busy"))]);
    onPlatform(t, "win32");
    renamesRefusedTwice(t, code);

    const result = library.commitUploads({ tokens: [preview.token], replace: [] });
    t.mock.restoreAll();

    assert.deepEqual(result, { installed: ["busy"], failed: [] }, code);
    assert.deepEqual(listDir(skillsDir), ["busy"], code);
  }
});

test("elsewhere, a refused rename isn't tried again", async (t) => {
  const { library } = setup(t);
  const [preview] = await library.previewUploads([markdownUpload("a.md", skillText("busy"))]);
  onPlatform(t, "darwin");
  renamesRefusedTwice(t, "EPERM");

  const result = library.commitUploads({ tokens: [preview.token], replace: [] });
  t.mock.restoreAll();

  assert.deepEqual(result, { installed: [], failed: [{ fileName: "a.md", error: "permission" }] });
});

// The app can stop between any two steps of a write, so each test stops it after one.
test("a replace cut short puts the old skill back when the library next opens", async (t) => {
  const { library, database, userDataDir, skillsDir } = setup(t);
  await upload(library, [markdownUpload("a.md", skillText("keep", "Old."))]);
  library.setEnabled("keep", false);
  const newer = markdownUpload("b.md", skillText("keep", "New."));
  const [preview] = await library.previewUploads([newer]);
  const realRename = fs.renameSync;
  let renames = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    renames += 1;
    if (renames > 1) throw Object.assign(new Error("stopped"), { code: "EIO" });
    return realRename(from, to);
  });
  library.commitUploads({ tokens: [preview.token], replace: ["keep"] });
  t.mock.restoreAll();
  assert.ok(!listDir(skillsDir).includes("keep"));

  const reopened = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

  assert.deepEqual(
    reopened.scan().map((skill) => [skill.name, skill.enabled, skill.description]),
    [["keep", false, "Old."]]
  );
  assert.deepEqual(listDir(skillsDir), ["keep"]);
});

test("a replace that finished leaves no old copy once the library next opens", async (t) => {
  const { library, database, userDataDir, skillsDir } = setup(t);
  await upload(library, [markdownUpload("a.md", skillText("keep", "Old."))]);
  const newer = markdownUpload("b.md", skillText("keep", "New."));
  const [preview] = await library.previewUploads([newer]);
  t.mock.method(fs, "rmSync", () => {
    throw Object.assign(new Error("stopped"), { code: "EIO" });
  });
  library.commitUploads({ tokens: [preview.token], replace: ["keep"] });
  t.mock.restoreAll();
  assert.equal(listDir(skillsDir).length, 2);

  const reopened = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

  assert.deepEqual(listDir(skillsDir), ["keep"]);
  assert.match(readSkill(skillsDir, "keep"), /New\./);
  assert.deepEqual(
    reopened.scan().map((skill) => skill.name),
    ["keep"]
  );
});

test("a skill uninstalled after its replace left the old copy behind stays gone", async (t) => {
  const { library, database, userDataDir, skillsDir } = setup(t);
  await upload(library, [markdownUpload("a.md", skillText("keep", "Old."))]);
  const newer = markdownUpload("b.md", skillText("keep", "New."));
  const [preview] = await library.previewUploads([newer]);
  // The old copy can't be removed for now, as when Windows holds one of its files.
  t.mock.method(fs, "rmSync", () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  });
  library.commitUploads({ tokens: [preview.token], replace: ["keep"] });
  t.mock.restoreAll();
  library.uninstall("keep");

  const reopened = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

  assert.deepEqual(reopened.scan(), []);
  assert.deepEqual(listDir(skillsDir), []);
});

// The disk as a stop right after the swap leaves it, with Windows still holding a file in the
// old copy at the next start: that start can't remove it, and nothing may bring it back later.
test("a replace's old copy that a start can't remove never comes back after an uninstall", async (t) => {
  const busy = () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  };
  // At that start the old copy can't be removed, or neither renamed nor removed.
  for (const held of [["rmSync"], ["rmSync", "renameSync"]]) {
    const { library, database, userDataDir, skillsDir } = setup(t);
    await upload(library, [markdownUpload("a.md", skillText("keep", "Old."))]);
    const oldCopy = ".replaced-00000000-0000-4000-8000-000000000000-keep";
    fs.cpSync(path.join(skillsDir, "keep"), path.join(skillsDir, oldCopy), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "keep", "SKILL.md"), skillText("keep", "New."));
    for (const method of held) t.mock.method(fs, method, busy);
    const restarted = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
    t.mock.restoreAll();

    restarted.uninstall("keep");
    const reopened = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

    assert.deepEqual(reopened.scan(), [], held.join(", "));
    assert.deepEqual(listDir(skillsDir), [], held.join(", "));
  }
});

// Renamed to the trash at that start, it stays gone even if the lock outlasts the uninstall.
test("a replace's old copy still held when its skill is uninstalled never comes back", async (t) => {
  const { library, database, userDataDir, skillsDir } = setup(t);
  await upload(library, [markdownUpload("a.md", skillText("keep", "Old."))]);
  const oldCopy = ".replaced-00000000-0000-4000-8000-000000000000-keep";
  fs.cpSync(path.join(skillsDir, "keep"), path.join(skillsDir, oldCopy), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "keep", "SKILL.md"), skillText("keep", "New."));
  const busy = () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  };
  t.mock.method(fs, "rmSync", busy);
  const restarted = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
  const realRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (path.basename(from).startsWith(".replaced-")) busy();
    return realRename(from, to);
  });
  restarted.uninstall("keep");
  t.mock.restoreAll();

  const reopened = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

  assert.deepEqual(reopened.scan(), []);
  assert.deepEqual(listDir(skillsDir), []);
});

test("a replace's old copy that can't be renamed to the trash is removed where it is", async (t) => {
  const { library, skillsDir } = setup(t);
  await upload(library, [markdownUpload("a.md", skillText("keep", "Old."))]);
  const newer = markdownUpload("b.md", skillText("keep", "New."));
  const [preview] = await library.previewUploads([newer]);
  const realRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (path.basename(to).startsWith(".trash-")) {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return realRename(from, to);
  });

  const result = library.commitUploads({ tokens: [preview.token], replace: ["keep"] });
  t.mock.restoreAll();

  assert.deepEqual(result, { installed: ["keep"], failed: [] });
  assert.deepEqual(listDir(skillsDir), ["keep"]);
  assert.match(readSkill(skillsDir, "keep"), /New\./);
});

test("an uninstall or a write cut short leaves nothing once the library next opens", async (t) => {
  const { library, database, userDataDir, skillsDir } = setup(t);
  await upload(library, [markdownUpload("gone.md", skillText("gone"))]);
  t.mock.method(fs, "rmSync", () => {
    throw Object.assign(new Error("stopped"), { code: "EIO" });
  });
  library.uninstall("gone");
  t.mock.restoreAll();
  writeFolder(skillsDir, ".staging-1234", { "SKILL.md": skillText("half") });
  assert.equal(listDir(skillsDir).length, 2);

  new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

  assert.deepEqual(listDir(skillsDir), []);
});

test("folders starting with a dot, like an interrupted write's, are never listed", (t) => {
  const { library, skillsDir } = setup(t);
  writeFolder(skillsDir, ".staging-1234", { "SKILL.md": skillText("half") });
  writeFolder(skillsDir, ".trash-5678", { "SKILL.md": skillText("old") });
  writeFolder(skillsDir, "real", { "SKILL.md": skillText("real") });
  fs.writeFileSync(path.join(skillsDir, "stray-file.md"), skillText("stray-file"));

  assert.deepEqual(
    library.scan().map((skill) => skill.name),
    ["real"]
  );
});

test("a folder whose name the app can't address is left out, not listed unmanageable", (t) => {
  const { library, database, skillsDir } = setup(t);
  writeFolder(skillsDir, "con", { "SKILL.md": skillText("con") });
  writeFolder(skillsDir, "what?", { "SKILL.md": skillText("what") });
  writeFolder(skillsDir, "real", { "SKILL.md": skillText("real") });

  assert.deepEqual(
    library.scan().map((skill) => skill.name),
    ["real"]
  );
  assert.deepEqual(
    database.getSkillStates().map((state) => state.name),
    ["real"]
  );
});

test("a symlinked skill folder or file is never followed", (t) => {
  const { library, skillsDir } = setup(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-skill-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "SKILL.md"), skillText("linked"));
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.symlinkSync(outside, path.join(skillsDir, "linked"), "dir");
  writeFolder(skillsDir, "has-link", { "SKILL.md": skillText("has-link") });
  fs.symlinkSync(path.join(outside, "SKILL.md"), path.join(skillsDir, "has-link", "notes.md"));

  const byName = Object.fromEntries(library.scan().map((skill) => [skill.name, skill]));

  assert.deepEqual(
    [byName.linked.valid, byName.linked.problem],
    [false, { code: "unreadable" }]
  );
  assert.deepEqual(
    [byName["has-link"].valid, byName["has-link"].problem],
    [false, { code: "unreadable" }]
  );
  assert.equal(library.readFile("has-link", "notes.md"), null);
  assert.equal(library.skillDir("linked"), null);
  assert.deepEqual([library.get("linked").markdown, library.get("linked").files], ["", []]);
});

test("a skill whose files can't be read opens as one that can't be read, not as empty", (t) => {
  const { library, skillsDir } = setup(t);
  writeFolder(skillsDir, "locked", {
    "SKILL.md": skillText("locked"),
    "references/a.md": "A",
  });
  writeFolder(skillsDir, "racy", { "SKILL.md": skillText("racy"), "references/b.md": "B" });
  library.scan();
  const realReaddir = fs.readdirSync;
  const realReadFile = fs.readFileSync;
  // The library reads through the folder's real path, so these match its end.
  t.mock.method(fs, "readdirSync", (dir, options) => {
    if (dir.endsWith(path.join("locked", "references"))) {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return realReaddir(dir, options);
  });
  // Gone between listing the folder and reading the file.
  t.mock.method(fs, "readFileSync", (file, options) => {
    if (String(file).endsWith(path.join("racy", "references", "b.md"))) {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
    return realReadFile(file, options);
  });

  const locked = library.get("locked");
  const racy = library.get("racy");
  t.mock.restoreAll();

  assert.deepEqual([locked.valid, locked.problem, locked.markdown, locked.files], [
    false,
    { code: "unreadable" },
    "",
    [],
  ]);
  assert.deepEqual([racy.valid, racy.problem, racy.markdown, racy.files], [
    false,
    { code: "unreadable" },
    "",
    [],
  ]);
});

test("readFile refuses paths outside the skill and binary files", (t) => {
  const { library, skillsDir } = setup(t);
  writeFolder(skillsDir, "reader", {
    "SKILL.md": skillText("reader"),
    "references/notes.md": "Notes",
    "assets/logo.png": Buffer.from([0x89, 0, 1]),
  });
  writeFolder(skillsDir, "other", { "SKILL.md": skillText("other") });
  library.scan();

  assert.equal(library.readFile("reader", "references/notes.md"), "Notes");
  assert.equal(library.readFile("reader", "assets/logo.png"), null);
  assert.equal(library.readFile("reader", "../other/SKILL.md"), null);
  assert.equal(library.readFile("reader", "/etc/hosts"), null);
  assert.equal(library.readFile("reader", "references/missing.md"), null);
  assert.equal(library.readFile("missing", "SKILL.md"), null);
});

test("the detail lists every file but SKILL.md, sorted, with text and script flags", (t) => {
  const { library, skillsDir } = setup(t);
  writeFolder(skillsDir, "crm", {
    "SKILL.md": skillText("crm"),
    "scripts/export.sh": "echo export",
    "references/notes.md": "Notes",
    "assets/logo.png": Buffer.from([0x89, 0, 1]),
    ".DS_Store": Buffer.from([0, 0, 0, 1]),
  });

  const detail = library.get("crm");

  assert.equal(detail.markdown, skillText("crm"));
  assert.deepEqual(detail.files, [
    { path: "assets/logo.png", size: 3, text: false, script: false },
    { path: "references/notes.md", size: 5, text: true, script: false },
    { path: "scripts/export.sh", size: 11, text: true, script: true },
  ]);
  assert.equal(library.get("missing"), null);
});

test("uninstall removes the folder and its row", async (t) => {
  const { library, database, skillsDir } = setup(t);
  await upload(library, [markdownUpload("x.md", skillText("remove-me"))]);

  library.uninstall("remove-me");

  assert.deepEqual(listDir(skillsDir), []);
  assert.equal(database.rows.has("remove-me"), false);
  assert.deepEqual(library.scan(), []);
});

test("create names the folder from the title and keeps it unique", (t) => {
  const { library, skillsDir } = setup(t);

  const first = library.create({
    title: "Weekly status report",
    description: "Writes my weekly update.",
    instructions: "## Steps\n1. Read notes.\n",
    files: [
      { fileName: "example.md", data: Buffer.from("Example") },
      { fileName: "export.sh", data: Buffer.from("echo hi") },
    ],
  });
  const second = library.create({
    title: "Weekly status report!",
    description: "Another.",
    instructions: "Go",
    files: [],
  });

  assert.deepEqual([first, second], [
    { name: "weekly-status-report" },
    { name: "weekly-status-report-2" },
  ]);
  assert.equal(
    readSkill(skillsDir, "weekly-status-report"),
    '---\nname: weekly-status-report\ndescription: "Writes my weekly update."\n' +
      'metadata:\n  display_name: "Weekly status report"\n---\n\n## Steps\n1. Read notes.\n'
  );
  const created = path.join(skillsDir, "weekly-status-report");
  assert.equal(fs.readFileSync(path.join(created, "references", "example.md"), "utf8"), "Example");
  assert.equal(fs.readFileSync(path.join(created, "scripts", "export.sh"), "utf8"), "echo hi");
});

// Create and Add refuse a title another skill already shows, so their cards can be told apart.
test("create refuses a title one of your skills already shows, naming that skill", (t) => {
  const { library, skillsDir } = setup(t);
  const make = (title) =>
    library.create({ title, description: "Recaps.", instructions: "Go", files: [] });
  assert.deepEqual(make("Weekly report"), { name: "weekly-report" });

  for (const title of ["Weekly report", "  weekly   REPORT "]) {
    assert.deepEqual(make(title), {
      problems: [{ code: "nameTaken", values: { name: "Weekly report" } }],
    });
  }
  assert.deepEqual(listDir(skillsDir), ["weekly-report"]);
});

test("a hand-made skill never takes a starter skill's folder", (t) => {
  const { library } = setup(t);
  const copy = { title: "Meeting decisions", description: "Finds decisions." };

  const made = library.create({ ...copy, instructions: "Mine", files: [] });

  assert.deepEqual(made, { name: "meeting-decisions-2" });
  assert.deepEqual(library.addRecommended("meeting-decisions", copy), {
    problems: [{ code: "nameTaken", values: { name: "Meeting decisions" } }],
  });
  library.uninstall("meeting-decisions-2");
  library.create({ ...copy, title: "  meeting   DECISIONS ", instructions: "Mine", files: [] });
  assert.deepEqual(library.addRecommended("meeting-decisions", copy), {
    problems: [{ code: "nameTaken", values: { name: "meeting   DECISIONS" } }],
  });
  const translated = { ...copy, title: "Décisions de réunion" };
  assert.deepEqual(library.addRecommended("meeting-decisions", translated), { name: "meeting-decisions" });
});

test("create returns the problems instead of writing a skill that can't be used", (t) => {
  const { library, skillsDir } = setup(t);
  const base = { title: "Draft", description: "Does it.", instructions: "Go", files: [] };

  assert.deepEqual(library.create({ ...base, instructions: "1. [TODO: steps]" }), {
    problems: [{ code: "placeholder" }],
  });
  assert.deepEqual(library.create({ ...base, description: "Wraps <b> tags" }), {
    problems: [{ code: "descriptionAngleBrackets" }],
  });
  assert.deepEqual(library.create({ ...base, title: "   " }), {
    problems: [{ code: "missingName" }],
  });
  assert.deepEqual(
    library.create({ ...base, files: [{ fileName: "../escape.md", data: Buffer.from("x") }] }),
    { problems: [{ code: "unsafePath", values: { path: "../escape.md" } }] }
  );
  assert.deepEqual(listDir(skillsDir), []);
});

test("create keeps an attached file that holds a [TODO: placeholder", (t) => {
  const { library, skillsDir } = setup(t);
  const base = { title: "Draft", description: "Does it.", instructions: "Go" };
  const template = { fileName: "template.md", data: Buffer.from("[TODO: your notes]") };

  assert.deepEqual(library.create({ ...base, files: [template] }), { name: "draft" });
  const saved = path.join(skillsDir, "draft", "references", "template.md");
  assert.equal(fs.readFileSync(saved, "utf8"), "[TODO: your notes]");
});

test("create refuses two files that would land on one path instead of keeping one", (t) => {
  const { library, skillsDir } = setup(t);
  const base = { title: "Draft", description: "Does it.", instructions: "Go" };
  const attach = (...names) => names.map((fileName) => ({ fileName, data: Buffer.from(fileName) }));

  for (const names of [
    ["notes.md", "notes.md"],
    ["Notes.md", "notes.md"],
  ]) {
    assert.deepEqual(library.create({ ...base, files: attach(...names) }), {
      problems: [{ code: "unsafePath" }],
    });
  }
  assert.deepEqual(listDir(skillsDir), []);
});

test(
  "adding a recommended skill writes the given title and description and keeps its body",
  (t) => {
    const { library, skillsDir } = setup(t);

    const result = library.addRecommended("meeting-decisions", {
      title: "Decisiones de reuniones",
      description: "Encuentra las decisiones en las notas de mis reuniones.",
    });

    assert.deepEqual(result, { name: "meeting-decisions" });
    const added = parseSkillMarkdown(readSkill(skillsDir, "meeting-decisions"));
    const shipped = parseSkillMarkdown(
      fs.readFileSync(path.join(RECOMMENDED_DIR, "meeting-decisions", "SKILL.md"), "utf8")
    );
    assert.deepEqual(
      [added.data.name, added.data.description, added.data.metadata.display_name, added.problems],
      [
        "meeting-decisions",
        "Encuentra las decisiones en las notas de mis reuniones.",
        "Decisiones de reuniones",
        [],
      ]
    );
    assert.equal(added.body, shipped.body);
    assert.equal(library.addRecommended("not-shipped", { title: "x", description: "y" }), null);
  }
);

// The shipped file names each starter as the app's English copy does, so the two stay in step.
test("every shipped recommended skill is valid and named as the app names it", () => {
  const english = require("../../../src/locales/en/translation.json").skills.recommended;
  for (const id of fs.readdirSync(RECOMMENDED_DIR)) {
    const text = fs.readFileSync(path.join(RECOMMENDED_DIR, id, "SKILL.md"), "utf8");
    const parsed = parseSkillMarkdown(text);
    assert.deepEqual([parsed.data.name, parsed.problems, parsed.warnings], [id, [], []], id);
    assert.equal(parsed.data.metadata.display_name, english[id].title, id);
  }
});

test("a refused archive leaves nothing on disk", async (t) => {
  const { library, userDataDir, skillsDir } = setup(t);
  const zip = buildZip([
    { path: "SKILL.md", data: skillText("evil") },
    { path: "../escape.md", data: "x" },
  ]);

  const [preview] = await library.previewUploads([{ fileName: "evil.zip", data: zip }]);

  assert.deepEqual(
    [preview.status, preview.token, preview.problems],
    ["invalid", undefined, [{ code: "unsafePath" }]]
  );
  assert.deepEqual(listDir(skillsDir), []);
  assert.equal(fs.existsSync(path.join(userDataDir, "escape.md")), false);
});
