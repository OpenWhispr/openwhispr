const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { replaceFrontmatterValue } = require("../../../src/helpers/skills/skillFormat");
const { RECOMMENDED_DIR, setup, writeFolder, readSkill, listDir } = require("./libraryFixture");
const { SkillLibrary } = require("../../../src/helpers/skills/skillLibrary");

const NAME = "enterprise-call-playbook";
// A hand-written header: a folded description, a comment, an unknown key, metadata and CRLF.
const SKILL_MD = [
  "---",
  `name: ${NAME}`,
  "description: >",
  "  Preps me for enterprise calls.",
  "  Use before a call.",
  "# kept: a comment",
  "when_to_use: Before calls",
  "metadata:",
  '  display_name: "Enterprise call playbook"',
  '  version: "3"',
  "---",
  "",
  "## Steps",
  "Ask about budget.",
  "",
].join("\r\n");
const OTHER_FILES = {
  "references/objections.md": "# Objections\n- We don't offer SSO.\n",
  "agents/openai.yaml": "interface:\n  display_name: Playbook\n",
  "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]),
};

function playbook(t) {
  const context = setup(t);
  writeFolder(context.skillsDir, NAME, { "SKILL.md": SKILL_MD, ...OTHER_FILES });
  context.library.scan();
  context.database.setSkillEnabled(NAME, true);
  return { ...context, versionsDir: path.join(context.userDataDir, "skill-versions", NAME) };
}

function snapshot(folder) {
  const files = {};
  const walk = (relDir) => {
    for (const entry of fs.readdirSync(path.join(folder, relDir), { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else files[relPath] = fs.readFileSync(path.join(folder, relPath)).toString("base64");
    }
  };
  walk("");
  return files;
}

const SSO = {
  name: NAME,
  description: "Preps me for enterprise calls, SSO pricing included.",
  instructions: "## Steps\nAsk about budget.\nHave the SSO answer ready.",
  files: [{ path: "references/objections.md", content: "# Objections\n- SSO: Enterprise.\n" }],
};

test("an update keeps every other frontmatter line byte for byte", (t) => {
  const { library, skillsDir } = playbook(t);

  library.applyUpdate(SSO);

  assert.equal(
    readSkill(skillsDir, NAME),
    [
      "---",
      `name: ${NAME}`,
      'description: "Preps me for enterprise calls, SSO pricing included."',
      "# kept: a comment",
      "when_to_use: Before calls",
      "metadata:",
      '  display_name: "Enterprise call playbook"',
      '  version: "3"',
      "---",
      "",
      "## Steps",
      "Ask about budget.",
      "Have the SSO answer ready.",
      "",
    ].join("\r\n")
  );
  const skillDir = path.join(skillsDir, NAME);
  assert.equal(
    fs.readFileSync(path.join(skillDir, "references/objections.md"), "utf8"),
    "# Objections\n- SSO: Enterprise.\n"
  );
  for (const relPath of ["agents/openai.yaml", "assets/logo.png"]) {
    const stored = fs.readFileSync(path.join(skillDir, relPath));
    assert.ok(stored.equals(Buffer.from(OTHER_FILES[relPath])), relPath);
  }
  assert.equal(library.scan()[0].valid, true);
});

test("a missing description key is added before the closing line", () => {
  assert.equal(
    replaceFrontmatterValue("---\nname: recap\n---\n\nBody\n", "description", 'Says "hi".'),
    '---\nname: recap\ndescription: "Says \\"hi\\"."\n---\n\nBody\n'
  );
  assert.throws(() => replaceFrontmatterValue("# No header\n", "description", "x"));
});

test("a header after a byte-order mark is still found, and the mark is kept", () => {
  assert.equal(
    replaceFrontmatterValue("\uFEFF---\ndescription: Before\n---\n", "description", "After"),
    '\uFEFF---\ndescription: "After"\n---\n'
  );
});

test("a quoted description key, or one spaced before its colon, is replaced in place", () => {
  for (const key of ['"description"', "'description'", "description "]) {
    assert.equal(
      replaceFrontmatterValue(`---\nname: recap\n${key}: Before\n---\n`, "description", "After"),
      '---\nname: recap\ndescription: "After"\n---\n',
      key
    );
  }
  // A longer key that starts the same way is another key.
  assert.equal(
    replaceFrontmatterValue("---\ndescription_note: keep\n---\n", "description", "After"),
    '---\ndescription_note: keep\ndescription: "After"\n---\n'
  );
});

test("an update keeps a version and Undo restores it exactly", (t) => {
  const { library, skillsDir, versionsDir } = playbook(t);
  const before = snapshot(path.join(skillsDir, NAME));

  const { versionId } = library.applyUpdate(SSO);
  assert.deepEqual(snapshot(path.join(versionsDir, versionId)), before);
  assert.notDeepEqual(snapshot(path.join(skillsDir, NAME)), before);

  library.undo(NAME, versionId);

  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), before);
  assert.deepEqual(listDir(versionsDir), [], "the restored copy is gone");
  assert.equal(library.scan()[0].enabled, true);
});

test("Undo refuses once a later change has replaced the one it would undo", (t) => {
  const { library, skillsDir } = playbook(t);
  const first = library.applyUpdate({ ...SSO, files: [] }).versionId;
  const second = library.applyUpdate({ ...SSO, instructions: "## Steps\nAsk twice.", files: [] });
  const latest = snapshot(path.join(skillsDir, NAME));

  assert.equal(library.undo(NAME, first), false);
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), latest, "the later change stays");

  assert.equal(library.undo(NAME, second.versionId), true);
  assert.equal(library.undo(NAME, first), true, "newest first, each Undo still works");
});

test("Undo refuses once the skill was changed outside the app", (t) => {
  const { library, skillsDir } = playbook(t);
  const { versionId } = library.applyUpdate({ ...SSO, files: [] });
  // An edit by hand, or an upload that replaced the folder, keeps no version.
  fs.writeFileSync(path.join(skillsDir, NAME, "references", "objections.md"), "# Mine\n");
  const edited = snapshot(path.join(skillsDir, NAME));

  assert.equal(library.undo(NAME, versionId), false);
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), edited);
});

test("Undo puts back whether the replaced skill was switched on", (t) => {
  const { library, skillsDir, database } = setup(t);
  writeFolder(skillsDir, "weekly-recap", {
    "SKILL.md": "---\nname: weekly-recap\ndescription: Recaps.\n---\n\nOld\n",
  });
  library.scan(); // found on disk, so it starts off
  const proposal = { title: "Weekly recap", description: "Recaps.", instructions: "New" };

  const { versionId } = library.saveProposal({ ...proposal, files: [] });
  assert.equal(library.scan()[0].enabled, true, "the approved save switches it on");
  assert.equal(library.undo("weekly-recap", versionId), true);

  assert.equal(library.scan()[0].enabled, false);
  assert.equal(database.getSkillStates()[0].enabled, false);
});

test("Undo keeps a switch the user changed after the save", (t) => {
  const { library, database } = playbook(t);
  const { versionId } = library.applyUpdate({ ...SSO, files: [] });
  database.setSkillEnabled(NAME, false);

  assert.equal(library.undo(NAME, versionId), true);

  assert.equal(library.scan()[0].enabled, false);
});

test("only the five newest versions are kept", (t) => {
  const { library, versionsDir } = playbook(t);

  const ids = [];
  for (let round = 1; round <= 7; round += 1) {
    ids.push(library.applyUpdate({ ...SSO, instructions: `Round ${round}`, files: [] }).versionId);
  }

  // Each kept copy has a folder and, beside it, a note of what its save wrote.
  const kept = [...ids].sort().slice(2);
  assert.deepEqual(listDir(versionsDir), [...kept, ...kept.map((id) => `${id}.json`)].sort());
  assert.equal(new Set(ids).size, 7);
});

test("uninstall removes the skill's versions", (t) => {
  const { library, versionsDir } = playbook(t);
  const { versionId } = library.applyUpdate(SSO);
  assert.deepEqual(listDir(versionsDir), [versionId, `${versionId}.json`]);

  library.uninstall(NAME);

  assert.equal(fs.existsSync(versionsDir), false);
});

// Kept versions are full copies of the skill's files, so none outlive the skill.
test("an uninstall cut short leaves none of the skill's versions once the library next opens", (t) => {
  const { library, database, userDataDir, versionsDir } = playbook(t);
  library.applyUpdate(SSO);
  // The app stops once the skill's folder is in the trash, before anything is removed.
  t.mock.method(fs, "rmSync", () => {
    throw Object.assign(new Error("stopped"), { code: "EIO" });
  });
  library.uninstall(NAME);
  t.mock.restoreAll();
  assert.equal(listDir(versionsDir).length, 2);

  new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

  assert.equal(fs.existsSync(versionsDir), false);
});

// A start that can't put a replaced skill back keeps its versions for the start that does.
test("a skill waiting to be put back keeps its versions until it is back", (t) => {
  const { library, database, userDataDir, skillsDir, versionsDir } = playbook(t);
  const { versionId } = library.applyUpdate(SSO);
  // The app stopped in the middle of a replace, with the skill moved aside.
  fs.renameSync(
    path.join(skillsDir, NAME),
    path.join(skillsDir, `.replaced-00000000-0000-4000-8000-000000000000-${NAME}`)
  );
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("busy"), { code: "EPERM" });
  });
  new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
  t.mock.restoreAll();
  assert.equal(fs.existsSync(versionsDir), true);

  const later = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

  assert.deepEqual(
    later.scan().map((skill) => skill.name),
    [NAME]
  );
  assert.equal(later.undo(NAME, versionId), true);
});

test("a failed update leaves the skill and its versions as they were", (t) => {
  const { library, skillsDir, versionsDir } = playbook(t);
  const { versionId } = library.applyUpdate(SSO);
  const skill = snapshot(path.join(skillsDir, NAME));
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });

  assert.throws(() => library.applyUpdate({ ...SSO, instructions: "Lost" }), { code: "noSpace" });
  t.mock.restoreAll();

  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), skill);
  assert.deepEqual(listDir(versionsDir), [versionId, `${versionId}.json`]);
  assert.deepEqual(
    listDir(skillsDir).filter((name) => name.startsWith(".")),
    [],
    "no staging or trash folder"
  );
});

test("an update needs a switched-on, valid skill and is checked like a proposal", (t) => {
  const { library, database } = playbook(t);
  const check = (update) => library.checkProposal({ kind: "update", update });

  const { hash, ...checked } = check(SSO);
  assert.deepEqual(checked, { name: NAME, existing: true, problems: [] });
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(check({ ...SSO, instructions: "[TODO: ask]" }).problems, [
    { code: "placeholder" },
  ]);
  assert.deepEqual(
    check({ ...SSO, files: [{ path: "../escape.md", content: "x" }] }).problems.map(
      (problem) => problem.code
    ),
    ["unsafePath"]
  );
  assert.deepEqual(
    library.applyUpdate({ ...SSO, description: "<b>bold</b>" }).problems.map((p) => p.code),
    ["descriptionAngleBrackets"]
  );
  database.setSkillEnabled(NAME, false);
  assert.equal(check(SSO), null);
  assert.equal(library.applyUpdate(SSO), null);
});

test("an update is refused once the skill changed after its card was made", (t) => {
  const { library, skillsDir } = playbook(t);
  const { hash } = library.checkProposal({ kind: "update", update: SSO });
  // Another card for the same skill is saved first.
  library.applyUpdate({ ...SSO, instructions: "## Steps\nFirst card." });
  const afterFirst = snapshot(path.join(skillsDir, NAME));

  assert.deepEqual(library.applyUpdate({ ...SSO, baseHash: hash }), { changed: true });
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), afterFirst);
});

test("a save whose Undo note can't be written still saves, without Undo", (t) => {
  const { library, skillsDir, versionsDir } = playbook(t);
  const writeFileSync = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (String(file).endsWith(".json")) {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    return writeFileSync(file, ...rest);
  });

  const saved = library.applyUpdate(SSO);
  t.mock.restoreAll();

  assert.deepEqual(saved, { name: NAME, versionId: undefined });
  assert.match(readSkill(skillsDir, NAME), /Have the SSO answer ready\./);
  assert.deepEqual(listDir(versionsDir), []);
});
