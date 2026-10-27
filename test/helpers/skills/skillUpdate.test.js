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

test(
  "an update preserves permissions of retained and edited files",
  { skip: process.platform === "win32" },
  (t) => {
    const { library, skillsDir } = playbook(t);
    const folder = path.join(skillsDir, NAME);
    writeFolder(skillsDir, NAME, { "scripts/run.sh": "#!/bin/sh\nprintf before\n" });
    fs.chmodSync(path.join(folder, "scripts/run.sh"), 0o751);
    fs.chmodSync(path.join(folder, "references/objections.md"), 0o640);

    library.applyUpdate({ name: NAME, description: "Updated description.", files: [] });

    assert.equal(fs.statSync(path.join(folder, "scripts/run.sh")).mode & 0o777, 0o751);
    assert.equal(fs.statSync(path.join(folder, "references/objections.md")).mode & 0o777, 0o640);

    library.applyUpdate({
      name: NAME,
      files: [{ path: "scripts/run.sh", content: "#!/bin/sh\nprintf after\n" }],
    });

    assert.equal(fs.statSync(path.join(folder, "scripts/run.sh")).mode & 0o777, 0o751);
    assert.equal(
      fs.readFileSync(path.join(folder, "scripts/run.sh"), "utf8"),
      "#!/bin/sh\nprintf after\n"
    );
  }
);

test("Undo restores the saved file permissions", { skip: process.platform === "win32" }, (t) => {
  const { library, skillsDir } = playbook(t);
  writeFolder(skillsDir, NAME, { "scripts/run.sh": "#!/bin/sh\nprintf before\n" });
  const script = path.join(skillsDir, NAME, "scripts/run.sh");
  fs.chmodSync(script, 0o751);
  const { versionId } = library.applyUpdate({
    name: NAME,
    files: [{ path: "scripts/run.sh", content: "#!/bin/sh\nprintf after\n" }],
  });

  assert.equal(library.undo(NAME, versionId), true);

  assert.equal(fs.statSync(script).mode & 0o777, 0o751);
  assert.equal(fs.readFileSync(script, "utf8"), "#!/bin/sh\nprintf before\n");
});

test("a restart discards an unfinished snapshot so the last successful save can be undone", (t) => {
  const { library, database, userDataDir, skillsDir, versionsDir } = playbook(t);
  const before = snapshot(path.join(skillsDir, NAME));
  const { versionId } = library.applyUpdate(SSO);
  // The process stops after copying the old skill, before writing the next update.
  const incomplete = library.saveVersion(NAME);

  const restarted = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

  assert.equal(restarted.undo(NAME, versionId), true);
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), before);
  assert.equal(fs.existsSync(path.join(versionsDir, incomplete)), false);
});

test("discarding an unfinished snapshot does not undo a later write that already landed", (t) => {
  const { library, database, userDataDir, skillsDir, versionsDir } = playbook(t);
  const { versionId } = library.applyUpdate(SSO);
  const incomplete = library.saveVersion(NAME);
  // The next write landed, but the process stopped before its Undo note was written.
  fs.writeFileSync(path.join(skillsDir, NAME, "references/objections.md"), "A later answer.\n");
  const latest = snapshot(path.join(skillsDir, NAME));

  const restarted = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });

  assert.equal(restarted.undo(NAME, versionId), false);
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), latest);
  assert.equal(fs.existsSync(path.join(versionsDir, incomplete)), false);
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

  const draft = { ...proposal, files: [] };
  const { hash } = library.checkProposal({ kind: "create", proposal: draft });
  const { versionId } = library.saveProposal({ ...draft, baseHash: hash });
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
    if (path.dirname(file) === versionsDir && String(file).endsWith(".json")) {
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

test("a failed write with five versions kept loses none of them", (t) => {
  const { library, versionsDir } = playbook(t);
  for (let round = 1; round <= 5; round += 1) {
    library.applyUpdate({ ...SSO, instructions: `Round ${round}`, files: [] });
  }
  const kept = listDir(versionsDir);
  assert.equal(kept.length, 10);
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });

  assert.throws(() => library.applyUpdate({ ...SSO, instructions: "Lost" }), { code: "noSpace" });
  t.mock.restoreAll();

  assert.deepEqual(listDir(versionsDir), kept);
});

test("a version copy cut short is removed and says why", (t) => {
  const { library, skillsDir, versionsDir } = playbook(t);
  const skill = snapshot(path.join(skillsDir, NAME));
  t.mock.method(fs, "cpSync", (_from, to) => {
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, "SKILL.md"), "half");
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });

  assert.throws(() => library.applyUpdate(SSO), { code: "noSpace" });
  t.mock.restoreAll();

  assert.deepEqual(listDir(versionsDir), [], "no half copy left to count as a version");
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), skill);
});

test("Undo of a kept copy that can't be read fails without blaming a later change", (t) => {
  const { library, versionsDir } = playbook(t);
  const { versionId } = library.applyUpdate(SSO);
  fs.writeFileSync(path.join(versionsDir, `${versionId}.json`), "{ not json");

  assert.throws(() => library.undo(NAME, versionId), { code: "unknown" });
});

test("Undo is refused once the skill was deleted by hand", (t) => {
  const { library, skillsDir } = playbook(t);
  const { versionId } = library.applyUpdate(SSO);
  fs.rmSync(path.join(skillsDir, NAME), { recursive: true });

  assert.equal(library.undo(NAME, versionId), false);
});


test("an update whose database write fails preserves files and prior Undo history", (t) => {
  const { library, database, skillsDir, versionsDir } = playbook(t);
  const original = snapshot(path.join(skillsDir, NAME));
  const first = library.applyUpdate(SSO);
  const before = snapshot(path.join(skillsDir, NAME));
  const state = database.getSkillStates();
  const versions = listDir(versionsDir);
  t.mock.method(database, "upsertSkillState", () => {
    throw Object.assign(new Error("database full"), { code: "SQLITE_FULL" });
  });

  assert.throws(
    () => library.applyUpdate({ ...SSO, instructions: "A second update." }),
    /database full/
  );
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), before);
  assert.deepEqual(database.getSkillStates(), state);
  assert.deepEqual(listDir(versionsDir), versions);
  t.mock.restoreAll();

  assert.equal(library.undo(NAME, first.versionId), true);
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), original);
});

test("a failed assistant replacement keeps a disabled skill unchanged and can retry", (t) => {
  const { library, database, skillsDir, versionsDir } = playbook(t);
  database.setSkillEnabled(NAME, false);
  const proposal = {
    title: "Enterprise call playbook",
    description: "Updated playbook.",
    instructions: "Ask about SSO.",
    files: [],
  };
  const { hash } = library.checkProposal({ kind: "create", proposal });
  const draft = { ...proposal, baseHash: hash };
  const before = snapshot(path.join(skillsDir, NAME));
  const state = database.getSkillStates();
  t.mock.method(database, "upsertSkillState", () => {
    throw Object.assign(new Error("database full"), { code: "SQLITE_FULL" });
  });

  assert.throws(() => library.saveProposal(draft), /database full/);
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), before);
  assert.deepEqual(database.getSkillStates(), state);
  assert.deepEqual(listDir(versionsDir), []);
  t.mock.restoreAll();

  const saved = library.saveProposal(draft);
  assert.equal(saved.name, NAME);
  assert.equal(library.get(NAME).enabled, true);
  assert.equal(library.undo(NAME, saved.versionId), true);
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), before);
  assert.equal(library.get(NAME).enabled, false);
});

test("Undo whose database write fails keeps the saved version available for retry", (t) => {
  const { library, database, skillsDir, versionsDir } = playbook(t);
  const original = snapshot(path.join(skillsDir, NAME));
  const { versionId } = library.applyUpdate(SSO);
  const updated = snapshot(path.join(skillsDir, NAME));
  const state = database.getSkillStates();
  const versions = listDir(versionsDir);
  t.mock.method(database, "upsertSkillState", () => {
    throw Object.assign(new Error("database full"), { code: "SQLITE_FULL" });
  });

  assert.throws(() => library.undo(NAME, versionId), /database full/);
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), updated);
  assert.deepEqual(database.getSkillStates(), state);
  assert.deepEqual(listDir(versionsDir), versions);
  t.mock.restoreAll();

  assert.equal(library.undo(NAME, versionId), true);
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), original);
  assert.deepEqual(listDir(versionsDir), []);
});

for (const operation of ["save", "undo"]) {
  test(`a failed ${operation} commit marker restores the complete database state`, (t) => {
    const { library, database, skillsDir, versionsDir, userDataDir } = playbook(t);
    database.setSkillEnabled(NAME, false);
    database.markSkillUsed(NAME);
    const proposal = {
      title: "Enterprise call playbook",
      description: "New playbook.",
      instructions: "New instructions.",
      files: [],
    };
    const { hash } = library.checkProposal({ kind: "create", proposal });
    const draft = { ...proposal, baseHash: hash };
    const saved = operation === "undo" ? library.saveProposal(draft) : null;
    const before = snapshot(path.join(skillsDir, NAME));
    const state = database.getSkillStates();
    const versions = listDir(versionsDir);
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (
        path.basename(from).startsWith(".replacing-") &&
        path.basename(to).startsWith(".replaced-")
      ) {
        throw Object.assign(new Error("commit marker locked"), { code: "EACCES" });
      }
      return rename(from, to);
    });
    assert.throws(
      () =>
        operation === "undo" ? library.undo(NAME, saved.versionId) : library.saveProposal(draft),
      /commit marker locked/
    );
    t.mock.restoreAll();
    assert.deepEqual(snapshot(path.join(skillsDir, NAME)), before);
    assert.deepEqual(database.getSkillStates(), state);
    assert.deepEqual(listDir(versionsDir), versions);
    const restarted = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
    assert.equal(restarted.get(NAME).enabled, operation === "undo");
    assert.deepEqual(database.getSkillStates(), state);
    if (saved) assert.equal(restarted.undo(NAME, saved.versionId), true);
  });
}

test("restart recovers a saved row and files when final journal commit and rollback are locked", (t) => {
  const { library, database, userDataDir, skillsDir } = playbook(t);
  database.setSkillEnabled(NAME, false);
  const before = snapshot(path.join(skillsDir, NAME));
  const state = database.getSkillStates();
  const proposal = {
    title: "Enterprise call playbook",
    description: "Changed.",
    instructions: "Changed.",
    files: [],
  };
  const { hash } = library.checkProposal({ kind: "create", proposal });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (
      (path.basename(from).startsWith(".writing-") && path.basename(to).startsWith(".written-")) ||
      (from === path.join(skillsDir, NAME) && path.basename(to).startsWith(".staging-"))
    ) {
      throw Object.assign(new Error("locked"), { code: "EACCES" });
    }
    return rename(from, to);
  });
  assert.throws(() => library.saveProposal({ ...proposal, baseHash: hash }), /locked/);
  assert.deepEqual(library.scan(), []);
  t.mock.restoreAll();
  const restarted = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), before);
  assert.equal(restarted.get(NAME).enabled, false);
  assert.deepEqual(database.getSkillStates(), state);
  assert.deepEqual(listDir(skillsDir), [NAME]);
});

test("a blocked database restoration keeps the failed save hidden until recovery succeeds", (t) => {
  const { library, database, userDataDir, skillsDir } = playbook(t);
  database.setSkillEnabled(NAME, false);
  const before = snapshot(path.join(skillsDir, NAME));
  const state = database.getSkillStates();
  const proposal = {
    title: "Enterprise call playbook",
    description: "Changed.",
    instructions: "Changed.",
    files: [],
  };
  const { hash } = library.checkProposal({ kind: "create", proposal });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (
      path.basename(from).startsWith(".replacing-") &&
      path.basename(to).startsWith(".replaced-")
    ) {
      throw new Error("marker locked");
    }
    return rename(from, to);
  });
  t.mock.method(database, "restoreSkillState", () => {
    throw new Error("database locked");
  });
  assert.throws(() => library.saveProposal({ ...proposal, baseHash: hash }), /marker locked/);
  const blocked = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
  assert.deepEqual(blocked.scan(), []);
  t.mock.restoreAll();
  const restarted = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
  assert.deepEqual(snapshot(path.join(skillsDir, NAME)), before);
  assert.equal(restarted.get(NAME).enabled, false);
  assert.deepEqual(database.getSkillStates(), state);
});

test("Undo waits for an older rollback even when the content is unchanged", (t) => {
  const { library, database, userDataDir } = setup(t);
  const proposal = {
    title: "Demo",
    description: "Description",
    instructions: "Original instructions",
    files: [],
  };
  library.create(proposal);
  library.setEnabled("demo", false);
  const { hash } = library.checkProposal({ kind: "create", proposal });
  const { versionId } = library.saveProposal({ ...proposal, baseHash: hash });
  const rename = fs.renameSync;
  let blockMarker = true;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (
      blockMarker &&
      path.basename(from).startsWith(".replacing-") &&
      path.basename(to).startsWith(".replaced-")
    ) {
      throw new Error("marker failed");
    }
    return rename(from, to);
  });
  t.mock.method(database, "restoreSkillState", () => {
    throw new Error("restoration blocked");
  });
  assert.throws(() => library.undo("demo", versionId), /marker failed/);
  blockMarker = false;
  assert.throws(() => library.undo("demo", versionId), /recovery/);
  t.mock.restoreAll();
  assert.equal(library.undo("demo", versionId), true);
  const restarted = new SkillLibrary({ userDataDir, database, recommendedDir: RECOMMENDED_DIR });
  assert.equal(restarted.get("demo").enabled, false);
});
