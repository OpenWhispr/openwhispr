const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { skillText, setup, writeFolder, listDir, readSkill } = require("./libraryFixture");

const KB = 1024;

// A skill found on disk starts off, so these switch it on as the user would.
function enabledSkill(t, files = {}) {
  const context = setup(t);
  writeFolder(context.skillsDir, "meeting-prep", {
    "SKILL.md": skillText("meeting-prep"),
    ...files,
  });
  context.library.scan();
  context.database.setSkillEnabled("meeting-prep", true);
  return context;
}

const proposal = (overrides = {}) => ({
  title: "Weekly recap",
  description: "Recaps my week. Use on Fridays.",
  instructions: "## Steps\nSum up the week.\n",
  files: [],
  ...overrides,
});

const check = (library, overrides) =>
  library.checkProposal({ kind: "create", proposal: proposal(overrides) });

test("the built-in creator is readable but never listed", (t) => {
  const { library } = setup(t);

  const creator = library.readForModel({ name: "skill-creator", builtin: true });

  assert.equal(creator.name, "skill-creator");
  assert.equal(creator.displayName, "Skill creator");
  assert.match(creator.body, /^# Skill creator\n/);
  assert.match(creator.body, /propose_skill/);
  assert.deepEqual(creator.files, []);
  assert.deepEqual(library.scan(), []);
  assert.equal(library.readForModel({ name: "skill-creator" }), null);
  assert.equal(library.readForModel({ name: "meeting-decisions", builtin: true }), null);
});

test("a disabled or invalid skill can't be read for the model", (t) => {
  const { library, skillsDir, database } = setup(t);
  writeFolder(skillsDir, "meeting-prep", { "SKILL.md": skillText("meeting-prep") });
  writeFolder(skillsDir, "broken", { "SKILL.md": "---\nname: broken\n---\n\nSteps\n" });
  library.scan();

  assert.equal(library.readForModel({ name: "meeting-prep" }), null);

  database.setSkillEnabled("meeting-prep", true);
  database.setSkillEnabled("broken", true);
  assert.deepEqual(library.readForModel({ name: "meeting-prep" }), {
    name: "meeting-prep",
    displayName: "Meeting prep",
    body: "Steps\n",
    files: [],
  });
  assert.equal(library.readForModel({ name: "broken" }), null);
});

// The list still shows it as fine, as when a permission changed or Windows holds a file.
test("a skill whose files can't be read gives the assistant nothing, not an empty skill", (t) => {
  const { library } = enabledSkill(t, { "references/a.md": "A" });
  const realReadFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, options) => {
    if (String(file).endsWith(path.join("meeting-prep", "SKILL.md"))) {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return realReadFile(file, options);
  });

  const read = library.readForModel({ name: "meeting-prep" });
  t.mock.restoreAll();

  assert.equal(read, null);
});

test("a file is read only if it is a listed text file", (t) => {
  const { library } = enabledSkill(t, {
    "references/objections.md": "Price: anchor high.\n",
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]),
  });

  const skill = library.readForModel({ name: "meeting-prep", file: "references/objections.md" });

  assert.deepEqual(skill.files, [
    { path: "assets/logo.png", size: 6, text: false, script: false },
    {
      path: "references/objections.md",
      size: 20,
      text: true,
      script: false,
      content: "Price: anchor high.\n",
    },
  ]);
  for (const file of ["assets/logo.png", "references/other.md", "SKILL.md", "../broken/SKILL.md"]) {
    assert.equal(library.readForModel({ name: "meeting-prep", file }), null, file);
  }
});

test("withFiles stops adding file text at 200 KB", (t) => {
  const { library } = enabledSkill(t, {
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]),
    "references/a.md": "a".repeat(150 * KB),
    "references/b.md": "b".repeat(60 * KB),
    "references/c.md": "c\n",
  });

  const skill = library.readForModel({ name: "meeting-prep", withFiles: true });

  assert.deepEqual(
    skill.files.map((file) => [file.path, file.content?.length]),
    [
      ["assets/logo.png", undefined],
      ["references/a.md", 150 * KB],
      ["references/b.md", undefined],
      ["references/c.md", undefined],
    ]
  );
});

test("a proposal with a [TODO: placeholder is refused with its reason", (t) => {
  const { library, skillsDir } = setup(t);
  const instructions = "## Steps\n[TODO: ask which day]\n";

  assert.deepEqual(check(library, { instructions }), {
    name: "weekly-recap",
    existing: false,
    problems: [{ code: "placeholder" }],
  });
  assert.deepEqual(library.saveProposal(proposal({ instructions })), {
    problems: [{ code: "placeholder" }],
  });
  assert.deepEqual(listDir(skillsDir), []);
});

test("a proposal whose title matches a skill updates it and keeps a version", (t) => {
  const { library, skillsDir, userDataDir } = setup(t);
  library.create({
    title: "Weekly recap",
    description: "Recaps the week.",
    instructions: "Old steps",
    files: [],
  });
  const before = readSkill(skillsDir, "weekly-recap");

  const checked = check(library, { title: "Weekly  recap " });
  assert.deepEqual(checked, {
    name: "weekly-recap",
    existing: true,
    problems: [],
    hash: checked.hash,
  });
  assert.match(checked.hash, /^[0-9a-f]{64}$/);
  const saved = library.saveProposal(proposal({ instructions: "New steps" }));

  assert.equal(saved.name, "weekly-recap");
  assert.match(readSkill(skillsDir, "weekly-recap"), /\nNew steps\n$/);
  const versionDir = path.join(userDataDir, "skill-versions", "weekly-recap", saved.versionId);
  assert.equal(fs.readFileSync(path.join(versionDir, "SKILL.md"), "utf8"), before);
  assert.deepEqual(
    library.scan().map((skill) => skill.name),
    ["weekly-recap"]
  );
});

test("a proposal's file paths and sizes are checked", (t) => {
  const { library } = setup(t);
  const codes = (files) => check(library, { files }).problems.map((problem) => problem.code);
  const file = (filePath, content = "x") => ({ path: filePath, content });

  assert.deepEqual(codes([file("references/examples.md"), file("scripts/run.sh")]), []);
  for (const bad of ["../a.md", "/etc/a.md", "C:/a.md", "references\\a.md", "a//b.md"]) {
    assert.deepEqual(codes([file(bad)]), ["unsafePath"], bad);
  }
  assert.deepEqual(codes([file("SKILL.md")]), ["unsafePath"]);
  assert.deepEqual(codes([file("references/a.md"), file("references/A.md")]), ["unsafePath"]);
  const many = Array.from({ length: 21 }, (_, index) => file(`references/${index}.md`));
  assert.deepEqual(codes(many), ["tooManyFiles"]);
  assert.deepEqual(codes([file("references/big.md", "x".repeat(200 * KB + 1))]), ["tooLarge"]);
  const full = Array.from({ length: 6 }, (_, index) =>
    file(`references/${index}.md`, "x".repeat(200 * KB))
  );
  assert.deepEqual(codes(full), ["tooLarge"]);
});

test("saving a new proposal writes a valid skill and switches it on", (t) => {
  const { library, skillsDir } = setup(t);
  const files = [{ path: "references/voice.md", content: "Warm and short.\n" }];

  assert.deepEqual(library.saveProposal(proposal({ files })), { name: "weekly-recap" });

  assert.deepEqual(
    library.scan().map(({ name, enabled, valid }) => ({ name, enabled, valid })),
    [{ name: "weekly-recap", enabled: true, valid: true }]
  );
  const voice = path.join(skillsDir, "weekly-recap", "references", "voice.md");
  assert.equal(fs.readFileSync(voice, "utf8"), "Warm and short.\n");
  const skill = library.readForModel({ name: "weekly-recap" });
  assert.equal(skill.displayName, "Weekly recap");
  assert.equal(skill.body, "## Steps\nSum up the week.\n");
});

test("marking a skill used stamps its last use", (t) => {
  const { library } = enabledSkill(t);
  assert.equal(library.scan()[0].lastUsedAt, null);

  library.markUsed("meeting-prep");

  assert.match(library.scan()[0].lastUsedAt, /^2026-10-20T/);
});

test("two proposals with non-Latin titles become two skills", (t) => {
  const { library } = setup(t);

  const first = library.saveProposal(proposal({ title: "会議の準備" }));
  assert.deepEqual(check(library, { title: "メール返信" }).existing, false);
  const second = library.saveProposal(proposal({ title: "メール返信" }));

  assert.notEqual(second.name, first.name);
  assert.equal(second.versionId, undefined, "nothing was replaced");
  assert.deepEqual(
    library
      .scan()
      .map((skill) => skill.displayName)
      .sort(),
    ["メール返信", "会議の準備"]
  );
});

test("a new proposal never takes a starter skill's folder", (t) => {
  const { library } = setup(t);

  const saved = library.saveProposal(proposal({ title: "Meeting decisions" }));

  assert.deepEqual(saved, { name: "meeting-decisions-2" });
  const copy = { title: "Décisions de réunion", description: "Finds decisions." };
  assert.deepEqual(library.addRecommended("meeting-decisions", copy), {
    name: "meeting-decisions",
  });
});

test("a title shown by one of the user's skills updates that skill", (t) => {
  const { library } = setup(t);
  library.create({ title: "Weekly recap", description: "Recaps.", instructions: "Old", files: [] });

  // Its folder name alone is not enough: this title only shares the slug.
  assert.deepEqual(check(library, { title: "Weekly-recap!" }).existing, false);
  const { hash, ...checked } = check(library, { title: "weekly RECAP" });
  assert.deepEqual(checked, { name: "weekly-recap", existing: true, problems: [] });
  assert.ok(hash);
});

test("a proposal that updates a skill keeps its other files and header lines", (t) => {
  const { library, skillsDir } = setup(t);
  writeFolder(skillsDir, "meeting-prep", {
    "SKILL.md": [
      "---",
      "name: meeting-prep",
      "description: Old.",
      "license: MIT",
      "metadata:",
      '  display_name: "Meeting prep"',
      "---",
      "",
      "Old steps",
      "",
    ].join("\n"),
    "references/template.md": "# Template\n",
    "scripts/x.py": "print(1)\n",
  });
  library.scan();

  const saved = library.saveProposal(
    proposal({
      title: "Meeting prep",
      description: "Preps me for meetings.",
      instructions: "New steps",
      files: [{ path: "references/extra.md", content: "Extra\n" }],
    })
  );

  assert.ok(saved.versionId);
  assert.deepEqual(listDir(path.join(skillsDir, "meeting-prep", "references")), [
    "extra.md",
    "template.md",
  ]);
  assert.equal(
    fs.readFileSync(path.join(skillsDir, "meeting-prep", "scripts", "x.py"), "utf8"),
    "print(1)\n"
  );
  const markdown = readSkill(skillsDir, "meeting-prep");
  assert.match(markdown, /\nlicense: MIT\n/);
  assert.match(markdown, /\ndescription: "?Preps me for meetings\."?\n/);
  assert.match(markdown, /\nNew steps\n$/);
});

test("a proposal that updates a skill is refused once the skill changed after its card", (t) => {
  const { library, skillsDir } = setup(t);
  library.create({ title: "Weekly recap", description: "Recaps.", instructions: "Old", files: [] });
  const { hash } = check(library, {});
  fs.appendFileSync(path.join(skillsDir, "weekly-recap", "SKILL.md"), "Added by hand\n");

  assert.deepEqual(library.saveProposal(proposal({ baseHash: hash })), { changed: true });
  assert.match(readSkill(skillsDir, "weekly-recap"), /Added by hand\n$/);

  const fresh = check(library, {}).hash;
  assert.equal(library.saveProposal(proposal({ baseHash: fresh })).name, "weekly-recap");
});
