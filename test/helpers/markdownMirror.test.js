const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return { app: { isReady: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let markdownMirror;
try {
  markdownMirror = require("../../src/helpers/markdownMirror");
} finally {
  Module._load = originalLoad;
}

test("a note title ending in transcript keeps both mirrored files", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  const note = {
    id: 7,
    title: "Meeting transcript",
    content: "Decisions and action items",
    created_at: "2026-07-21T12:00:00Z",
    transcript: JSON.stringify([
      { speaker: "speaker_0", timestamp: 0, text: "Hello from the meeting." },
    ]),
  };

  markdownMirror.init(basePath);
  markdownMirror.writeNote(note, "Personal");
  markdownMirror.writeTranscript(note, "Personal", {});

  const folderPath = path.join(basePath, "Personal");
  const notePath = path.join(folderPath, "7-meeting-transcript.md");
  const transcriptPath = path.join(folderPath, "7-meeting-transcript-transcript.md");

  assert.equal(fs.existsSync(notePath), true);
  assert.equal(fs.existsSync(transcriptPath), true);
  assert.equal(markdownMirror.getNotePath(note.id), notePath);
});

test("folder names cannot escape the configured mirror directory", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  markdownMirror.init(basePath);
  markdownMirror.writeNote({ id: 13, title: "Safe note", content: "Body" }, "../outside");

  const escapedPath = path.resolve(basePath, "..", "outside", "13-safe-note.md");
  const notePath = markdownMirror.getNotePath(13);
  assert.equal(fs.existsSync(escapedPath), false);
  assert.ok(notePath);
  assert.equal(path.relative(basePath, notePath).startsWith(`..${path.sep}`), false);
  assert.equal(readFrontmatter(fs.readFileSync(notePath, "utf8")).folder, "../outside");
});

test("unsafe folder names do not collide with portable folder names", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  markdownMirror.init(basePath);
  markdownMirror.writeNote({ id: 14, title: "Nested", content: "Unsafe folder" }, "team/docs");
  markdownMirror.writeNote({ id: 15, title: "Flat", content: "Portable folder" }, "team-docs");

  const unsafeFolderPath = markdownMirror.getFolderPath("team/docs");
  const portableFolderPath = markdownMirror.getFolderPath("team-docs");
  assert.ok(unsafeFolderPath);
  assert.ok(portableFolderPath);
  assert.notEqual(unsafeFolderPath, portableFolderPath);
  assert.equal(portableFolderPath, path.join(basePath, "team-docs"));

  markdownMirror.deleteNote(14);
  markdownMirror.removeVacatedDirs();

  assert.equal(fs.existsSync(unsafeFolderPath), false);
  assert.equal(fs.existsSync(path.join(portableFolderPath, "15-flat.md")), true);
});

test("encoded folder keys cannot collide with logical folder names", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  markdownMirror.init(basePath);
  markdownMirror.ensureFolder("team/docs");
  const encodedName = path.basename(markdownMirror.getFolderPath("team/docs"));
  markdownMirror.ensureFolder(encodedName);

  assert.notEqual(
    markdownMirror.getFolderPath("team/docs"),
    markdownMirror.getFolderPath(encodedName)
  );
});

test("writes reject a symlinked folder that resolves outside the mirror", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  fs.symlinkSync(outsidePath, path.join(basePath, "linked"), "dir");

  markdownMirror.init(basePath);
  markdownMirror.writeNote({ id: 16, title: "Escaped", content: "Body" }, "linked");

  assert.equal(fs.existsSync(path.join(outsidePath, "16-escaped.md")), false);
  assert.equal(markdownMirror.getFolderPath("linked"), null);
});

test("writes reject a symlinked note file without changing its target", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  const outsideFile = path.join(outsidePath, "outside.md");
  fs.writeFileSync(outsideFile, "unchanged", "utf8");

  markdownMirror.init(basePath);
  markdownMirror.ensureFolder("Personal");
  fs.symlinkSync(outsideFile, path.join(basePath, "Personal", "17-linked.md"), "file");
  markdownMirror.writeNote({ id: 17, title: "Linked", content: "Replacement" }, "Personal");

  assert.equal(fs.readFileSync(outsideFile, "utf8"), "unchanged");
  assert.equal(markdownMirror.getNotePath(17), null);
});

test("Windows-reserved and trailing-character folder names use distinct portable keys", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  const folderNames = ["CON", "NUL.txt", "CONIN$", "folder.", "folder "];

  markdownMirror.init(basePath);
  folderNames.forEach((folderName, index) => {
    markdownMirror.ensureFolder(folderName);
    markdownMirror.writeNote(
      { id: 20 + index, title: `Note ${index}`, content: folderName },
      folderName
    );
  });

  const diskNames = folderNames.map((folderName) => {
    const folderPath = markdownMirror.getFolderPath(folderName);
    assert.ok(folderPath);
    return path.basename(folderPath);
  });
  assert.equal(new Set(diskNames).size, folderNames.length);
  for (const diskName of diskNames) {
    assert.doesNotMatch(
      diskName,
      /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i
    );
    assert.doesNotMatch(diskName, /[ .]$/);
  }
});

test("portable folders still support the normal ensure, move, and delete journey", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  markdownMirror.init(basePath);
  markdownMirror.ensureFolder("Research");
  markdownMirror.writeNote({ id: 30, title: "Sources", content: "Body" }, "Research");
  markdownMirror.writeNote({ id: 30, title: "Sources", content: "Body" }, "Archive");
  markdownMirror.removeVacatedDirs();

  assert.equal(markdownMirror.getFolderPath("Research"), null);
  assert.equal(markdownMirror.getFolderPath("Archive"), path.join(basePath, "Archive"));
  assert.equal(fs.existsSync(path.join(basePath, "Archive", "30-sources.md")), true);

  markdownMirror.deleteNote(30);
  markdownMirror.removeVacatedDirs();
  assert.equal(markdownMirror.getFolderPath("Archive"), null);
});

test("renaming a mirrored note cleans up both stale files and reveals the note", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  const note = {
    id: 42,
    title: "Weekly sync",
    content: "Initial notes",
    created_at: "2026-07-21T12:00:00Z",
    transcript: JSON.stringify([
      { speaker: "speaker_0", timestamp: 0, text: "Hello from the meeting." },
    ]),
  };

  markdownMirror.init(basePath);
  markdownMirror.writeNote(note, "Personal");
  markdownMirror.writeTranscript(note, "Personal", {});

  const renamed = { ...note, title: "Renamed sync", content: "Updated notes" };
  markdownMirror.writeNote(renamed, "Personal");
  markdownMirror.writeTranscript(renamed, "Personal", {});

  const folderPath = path.join(basePath, "Personal");
  const notePath = path.join(folderPath, "42-renamed-sync.md");

  assert.deepEqual(fs.readdirSync(folderPath).sort(), [
    "42-renamed-sync-transcript.md",
    "42-renamed-sync.md",
  ]);
  assert.equal(markdownMirror.getNotePath(note.id), notePath);
  assert.match(fs.readFileSync(notePath, "utf-8"), /Updated notes$/);
});

function readFrontmatter(fileContent) {
  const match = fileContent.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "file should start with a --- fenced frontmatter block");
  const map = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_]+): (.*)$/);
    assert.ok(kv, `frontmatter line is a "key: value" mapping entry: ${JSON.stringify(line)}`);
    let value = kv[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    map[kv[1]] = value;
  }
  return map;
}

test("a title with control characters keeps the frontmatter a valid single-line mapping", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  const note = {
    id: 5,
    title: "Q3 Review\nconfidential\ttag",
    content: "Body text",
    created_at: "2026-07-21T12:00:00Z",
  };

  markdownMirror.init(basePath);
  markdownMirror.writeNote(note, "Personal");

  const notePath = markdownMirror.getNotePath(note.id);
  assert.ok(notePath, "the note file is discoverable, so its frontmatter parsed as a note");
  const frontmatter = readFrontmatter(fs.readFileSync(notePath, "utf-8"));

  // Every key survives and the title round-trips, control characters intact.
  assert.equal(frontmatter.id, "5");
  assert.equal(frontmatter.type, "personal");
  assert.equal(frontmatter.folder, "Personal");
  assert.equal(frontmatter.title, note.title);
});

test("deleteNote removes the note's other files even when one unlink fails", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  const note = {
    id: 9,
    title: "Team sync",
    content: "Body",
    created_at: "2026-07-21T12:00:00Z",
    transcript: JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Hello." }]),
  };

  markdownMirror.init(basePath);
  markdownMirror.writeNote(note, "Personal");
  markdownMirror.writeTranscript(note, "Personal", {});

  const folderPath = path.join(basePath, "Personal");
  assert.equal(fs.readdirSync(folderPath).length, 2);

  // Make the first unlink throw (e.g. the file is open in an external editor on
  // Windows); the remaining file must still be deleted rather than orphaned.
  const realUnlink = fs.unlinkSync;
  let failedPath = null;
  fs.unlinkSync = (target) => {
    if (failedPath === null) {
      failedPath = target;
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    }
    return realUnlink(target);
  };
  t.after(() => {
    fs.unlinkSync = realUnlink;
  });

  markdownMirror.deleteNote(note.id);
  fs.unlinkSync = realUnlink;

  // Only the file that genuinely could not be unlinked remains.
  assert.deepEqual(fs.readdirSync(folderPath), [path.basename(failedPath)]);
});

test("a note file re-saved with a BOM or CRLF is still recognised as its note", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  const note = {
    id: 11,
    title: "Quarterly plan",
    content: "Body",
    created_at: "2026-07-21T12:00:00Z",
  };

  markdownMirror.init(basePath);
  markdownMirror.writeNote(note, "Personal");

  const notePath = path.join(basePath, "Personal", "11-quarterly-plan.md");
  const original = fs.readFileSync(notePath, "utf-8");

  for (const rewritten of [original.replace(/\n/g, "\r\n"), `\uFEFF${original}`]) {
    fs.writeFileSync(notePath, rewritten, "utf-8");
    assert.equal(markdownMirror.getNotePath(note.id), notePath);
  }
});

const placement = (...segments) => ({ segments, space: segments[1] });

function tempMirror(t) {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  markdownMirror.init(basePath);
  return basePath;
}

test("a note is written at its full path and found there", (t) => {
  const basePath = tempMirror(t);

  markdownMirror.writeNote(
    { id: 50, title: "Deep", content: "Body" },
    {
      segments: ["Workspaces", "Acme", "Eng", "General"],
      workspace: "Acme",
      space: "Eng",
      folder: "General",
    }
  );

  const notePath = path.join(basePath, "Workspaces", "Acme", "Eng", "General", "50-deep.md");
  assert.equal(markdownMirror.getNotePath(50), notePath);
  const frontmatter = readFrontmatter(fs.readFileSync(notePath, "utf8"));
  assert.equal(frontmatter.workspace, "Acme");
  assert.equal(frontmatter.space, "Eng");
  assert.equal(frontmatter.folder, "General");
});

test("moving a note between nested folders leaves one copy", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 51, title: "Moves", content: "Body" };

  markdownMirror.writeNote(note, placement("Workspaces", "Acme", "Eng", "General"));
  markdownMirror.writeNote(note, placement("Private notes", "Mine"));

  assert.equal(
    fs.existsSync(path.join(basePath, "Workspaces", "Acme", "Eng", "General", "51-moves.md")),
    false
  );
  assert.equal(
    markdownMirror.getNotePath(51),
    path.join(basePath, "Private notes", "Mine", "51-moves.md")
  );
});

test("a transcript moves with its note and deleteNote finds both", (t) => {
  const basePath = tempMirror(t);
  const note = {
    id: 52,
    title: "Call",
    content: "Body",
    created_at: "2026-07-21T12:00:00Z",
    transcript: JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Hi" }]),
  };
  const oldPlace = placement("Workspaces", "Acme", "Eng", "General");
  const newPlace = placement("Workspaces", "Beta", "Eng");
  markdownMirror.writeTranscript(note, oldPlace, {});
  markdownMirror.writeTranscript(note, newPlace, {});

  assert.equal(
    fs.existsSync(
      path.join(basePath, "Workspaces", "Acme", "Eng", "General", "52-call-transcript.md")
    ),
    false
  );
  const moved = path.join(basePath, "Workspaces", "Beta", "Eng", "52-call-transcript.md");
  assert.equal(fs.existsSync(moved), true);

  markdownMirror.deleteNote(52);
  assert.equal(fs.existsSync(moved), false);
});

const skipOnWindows = {
  skip: process.platform === "win32" && "a read-only directory doesn't stop writes on Windows",
};

test("a write that fails leaves the note's existing file in place", skipOnWindows, (t) => {
  const basePath = tempMirror(t);
  const note = { id: 53, title: "Keep", content: "Body" };
  markdownMirror.writeNote(note, placement("Private notes", "Old"));
  const oldPath = markdownMirror.getNotePath(53);
  const lockedDir = path.join(basePath, "Private notes", "Locked");
  fs.mkdirSync(lockedDir, { recursive: true });
  fs.chmodSync(lockedDir, 0o500);
  try {
    markdownMirror.writeNote(note, placement("Private notes", "Locked"));
  } finally {
    fs.chmodSync(lockedDir, 0o700);
  }

  assert.equal(fs.existsSync(oldPath), true);
});

test("an unchanged note isn't rewritten", (t) => {
  tempMirror(t);
  const note = { id: 54, title: "Same", content: "Body", created_at: "x", updated_at: "y" };
  const place = placement("Private notes", "Mine");
  markdownMirror.writeNote(note, place);
  const filePath = markdownMirror.getNotePath(54);
  const past = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(filePath, past, past);

  markdownMirror.writeNote(note, place);

  assert.equal(fs.statSync(filePath).mtime.getTime(), past.getTime());
});

test("a name too long for one path segment still gets a directory", (t) => {
  tempMirror(t);

  markdownMirror.writeNote(
    { id: 55, title: "Long", content: "Body" },
    placement("Workspaces", "A".repeat(300), "Eng")
  );

  assert.ok(markdownMirror.getNotePath(55));
});

test("a nested level that is a link out of the mirror isn't written through", (t) => {
  const basePath = tempMirror(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  fs.mkdirSync(path.join(basePath, "Workspaces"));
  fs.symlinkSync(outsidePath, path.join(basePath, "Workspaces", "Acme"), "dir");

  markdownMirror.writeNote(
    { id: 56, title: "Escaped", content: "Body" },
    placement("Workspaces", "Acme", "Eng")
  );

  assert.deepEqual(fs.readdirSync(outsidePath), []);
  assert.equal(markdownMirror.getNotePath(56), null);
});

test("directories a note left are removed while empty, stopping at anything else", (t) => {
  const basePath = tempMirror(t);
  const place = placement("Workspaces", "Acme", "Eng", "General");
  markdownMirror.writeNote({ id: 69, title: "N", content: "Body" }, place);
  fs.writeFileSync(path.join(basePath, "Workspaces", "Acme", "keep.txt"), "mine");
  fs.writeFileSync(path.join(basePath, "Workspaces", "Acme", "Eng", ".DS_Store"), "x");

  markdownMirror.deleteNote(69);
  markdownMirror.removeVacatedDirs();

  assert.equal(fs.existsSync(path.join(basePath, "Workspaces", "Acme", "Eng")), false);
  assert.equal(fs.existsSync(path.join(basePath, "Workspaces", "Acme", "keep.txt")), true);
});

test("a directory a note left stays when it's a current folder's, and the base always stays", (t) => {
  const basePath = tempMirror(t);
  markdownMirror.writeNote({ id: 68, title: "N", content: "Body" }, "Kept");
  markdownMirror.writeNote({ id: 67, title: "N", content: "Body" }, "Only");

  markdownMirror.deleteNote(68);
  markdownMirror.deleteNote(67);
  markdownMirror.removeVacatedDirs(new Set(["Kept"]));

  assert.equal(fs.existsSync(path.join(basePath, "Kept")), true);
  assert.equal(fs.existsSync(path.join(basePath, "Only")), false);
  assert.equal(fs.existsSync(basePath), true);
});

const write = (note, ...segments) => markdownMirror.writeNote(note, placement(...segments));

test("an edit made outside the app survives the note moving", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 70, title: "Plan", content: "Body" };
  write(note, "Private notes", "Work");
  const oldPath = path.join(basePath, "Private notes", "Work", "70-plan.md");
  const edited = fs.readFileSync(oldPath, "utf8").replace("Body", "Body plus my edit");
  fs.writeFileSync(oldPath, edited);

  write(note, "Private notes", "Job");

  assert.equal(
    fs.readFileSync(path.join(basePath, "Private notes", "Work", "edited-70-plan.md"), "utf8"),
    edited
  );
  assert.equal(
    markdownMirror.getNotePath(70),
    path.join(basePath, "Private notes", "Job", "70-plan.md")
  );
});

test("an edit made outside the app survives the note being saved again", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 71, title: "Plan", content: "Body" };
  write(note, "Private notes");
  const filePath = path.join(basePath, "Private notes", "71-plan.md");
  fs.appendFileSync(filePath, "\nmine");

  write({ ...note, content: "Body v2" }, "Private notes");

  assert.match(
    fs.readFileSync(path.join(basePath, "Private notes", "edited-71-plan.md"), "utf8"),
    /mine$/
  );
  assert.match(fs.readFileSync(filePath, "utf8"), /Body v2$/);
});

test("a file the mirror never wrote is kept when a note needs its name", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "Private notes");
  fs.mkdirSync(dir, { recursive: true });
  const before = "---\nid: 72\n---\n\nfrom before a reset";
  fs.writeFileSync(path.join(dir, "72-plan.md"), before);

  write({ id: 72, title: "Plan", content: "new note" }, "Private notes");

  assert.equal(fs.readFileSync(path.join(dir, "edited-72-plan.md"), "utf8"), before);
  assert.match(fs.readFileSync(path.join(dir, "72-plan.md"), "utf8"), /new note$/);
});

test("a file left half done, identical to what would be written, is simply taken over", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 73, title: "Plan", content: "Body", created_at: "x", updated_at: "y" };
  write(note, "Private notes");
  const filePath = markdownMirror.getNotePath(73);
  const content = fs.readFileSync(filePath, "utf8");
  markdownMirror.setLedger(null);
  fs.writeFileSync(filePath, content);

  write(note, "Private notes");

  assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")), ["73-plan.md"]);
});

test("files the mirror didn't write are never taken for a note's", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "Workspaces", "Acme", "Private", "Work");
  write({ id: 2024, title: "Note", content: "Body" }, "Workspaces", "Acme", "Private", "Work");
  const daily = path.join(dir, "2024-01-15-daily.md");
  fs.writeFileSync(daily, "---\ntags: [daily]\n---\n\nmine");
  const other = path.join(dir, "74-old.md");
  fs.writeFileSync(other, "---\nid: 74\n---\n\nfrom another device");

  write({ id: 74, title: "New", content: "Body" }, "Workspaces", "Acme", "Private", "Work");
  markdownMirror.deleteNote(2024);
  markdownMirror.deleteNote(74);

  assert.equal(fs.readFileSync(daily, "utf8"), "---\ntags: [daily]\n---\n\nmine");
  assert.equal(fs.readFileSync(other, "utf8"), "---\nid: 74\n---\n\nfrom another device");
});

test("deleting a note keeps a file edited outside the app", (t) => {
  const basePath = tempMirror(t);
  write({ id: 75, title: "Plan", content: "Body" }, "Private notes");
  const filePath = path.join(basePath, "Private notes", "75-plan.md");
  fs.appendFileSync(filePath, "\nmine");

  markdownMirror.deleteNote(75);

  assert.equal(fs.existsSync(filePath), false);
  assert.match(
    fs.readFileSync(path.join(basePath, "Private notes", "edited-75-plan.md"), "utf8"),
    /mine$/
  );
});

test("deleting a note keeps an edited file from the old layout and drops an unchanged one", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "General");
  fs.mkdirSync(dir);
  const old = (id, body) =>
    `---\nid: ${id}\ntitle: T\ntype: personal\nfolder: General\ncreated: x\nupdated: y\n---\n\n${body}`;
  fs.writeFileSync(path.join(dir, "76-t.md"), old(76, "Body"));
  fs.writeFileSync(path.join(dir, "77-t.md"), old(77, "my edit"));

  markdownMirror.deleteNote(76, { id: 76, title: "T", content: "Body" });
  markdownMirror.deleteNote(77, { id: 77, title: "T", content: "Body" });
  markdownMirror.deleteNote(78);

  assert.deepEqual(fs.readdirSync(dir).sort(), ["edited-77-t.md"]);
});

test("an old .txt transcript is dropped only when it says what the note's transcript says", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "General");
  fs.mkdirSync(dir);
  const note = {
    id: 79,
    title: "Call",
    content: "Body",
    created_at: "2026-07-21T12:00:00Z",
    transcript: JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Hi" }]),
  };
  const { formatTxt } = require("../../src/helpers/transcriptFormatter");
  fs.writeFileSync(
    path.join(dir, "79-call-transcript.txt"),
    formatTxt(note, JSON.parse(note.transcript), {})
  );
  const edited = { ...note, id: 80 };
  fs.writeFileSync(
    path.join(dir, "80-call-transcript.txt"),
    `${formatTxt(edited, JSON.parse(edited.transcript), {})}\nmy own notes on the call`
  );

  markdownMirror.legacyNoteIds(["General"]);
  markdownMirror.writeTranscript(note, placement("Private notes"), {});
  markdownMirror.writeTranscript(edited, placement("Private notes"), {});

  assert.deepEqual(fs.readdirSync(dir), ["edited-80-call-transcript.txt"]);
});

test("an old folder called Private notes counts as the old layout", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "Private notes");
  fs.mkdirSync(dir);
  const old =
    "---\nid: 81\ntitle: T\ntype: personal\nfolder: Private notes\ncreated: x\nupdated: y\n---\n\nmy edit";
  fs.writeFileSync(path.join(dir, "81-t.md"), old);

  write({ id: 81, title: "T", content: "Body" }, "Private notes", "Work");

  assert.equal(fs.readFileSync(path.join(dir, "edited-81-t.md"), "utf8"), old);
});

test("a note in a folder whose name starts with a dot is still tracked", (t) => {
  const basePath = tempMirror(t);
  write({ id: 82, title: "One", content: "Body" }, "Private notes", ".archive");
  write({ id: 82, title: "Two", content: "Body" }, "Private notes", ".archive");

  assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes", ".archive")), ["82-two.md"]);
  markdownMirror.deleteNote(82);
  assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes", ".archive")), []);
});

test("a case-only folder rename keeps the file where the file system can't tell paths apart", (t) => {
  tempMirror(t);
  const note = { id: 83, title: "Plan", content: "Body" };
  write(note, "Private notes", "Work");
  const realStat = fs.statSync;
  t.mock.method(fs, "statSync", (target, options) => {
    const stats = realStat(target, options);
    return options?.bigint ? Object.assign(stats, { ino: 0n }) : stats;
  });

  write(note, "Private notes", "work");
  fs.statSync.mock.restore();

  assert.match(fs.readFileSync(markdownMirror.getNotePath(83), "utf8"), /Body$/);
});

test("a single write never scans the mirror's folders", (t) => {
  tempMirror(t);
  for (let folder = 0; folder < 5; folder++) {
    write(
      { id: 90 + folder, title: "N", content: "Body" },
      "Workspaces",
      "Acme",
      "Teamspaces",
      `F${folder}`
    );
  }
  const readdir = t.mock.method(fs, "readdirSync");

  write({ id: 90, title: "Renamed", content: "Body" }, "Workspaces", "Acme", "Teamspaces", "F0");

  const scannedDeep = readdir.mock.calls.some((call) =>
    String(call.arguments[0]).includes("Teamspaces")
  );
  readdir.mock.restore();
  assert.equal(scannedDeep, false);
});

test("an old-layout file whose frontmatter values were edited is kept", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "Personal");
  fs.mkdirSync(dir);
  const old =
    "---\nid: 84\ntitle: Board meeting\ntype: personal\nfolder: Personal\ncreated: x\nupdated: y\n---\n\nBody";
  fs.writeFileSync(path.join(dir, "84-meeting.md"), old);

  write({ id: 84, title: "Meeting", content: "Body", created_at: "x" }, "Private notes");

  assert.equal(fs.readFileSync(path.join(dir, "edited-84-meeting.md"), "utf8"), old);
});

test("a file in a top-level folder is only an old note file when its frontmatter names the note", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "Daily");
  fs.mkdirSync(dir);
  const daily = "---\ncreated: x\n---\n\nBody";
  fs.writeFileSync(path.join(dir, "2025-11-10.md"), daily);

  write({ id: 2025, title: "Note", content: "Body", created_at: "x" }, "Private notes");

  assert.deepEqual(fs.readdirSync(dir), ["2025-11-10.md"]);
  assert.equal(fs.readFileSync(path.join(dir, "2025-11-10.md"), "utf8"), daily);
  assert.equal(markdownMirror.legacyNoteIds().has(2025), false);
});

test("a re-save that only changes line endings or adds a BOM isn't an edit", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 85, title: "Plan", content: "Line one\nLine two" };
  for (const resave of [(text) => text.replace(/\n/g, "\r\n"), (text) => `\uFEFF${text}`]) {
    write(note, "Private notes");
    const filePath = markdownMirror.getNotePath(85);
    fs.writeFileSync(filePath, resave(fs.readFileSync(filePath, "utf8")));

    write({ ...note, content: `${note.content} v2` }, "Private notes");

    assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")), ["85-plan.md"]);
  }
});

test("a title cut inside an emoji still leaves one file the mirror keeps track of", (t) => {
  const basePath = tempMirror(t);
  // SQLite stores text as UTF-8, which turns half an emoji into U+FFFD.
  const stored = new Map();
  markdownMirror.setLedger({
    files: (base) => [...stored.values()].filter((entry) => entry.base === base),
    record: (base, entry) =>
      stored.set(Buffer.from(entry.relPath).toString(), {
        ...entry,
        base,
        relPath: Buffer.from(entry.relPath).toString(),
      }),
    forget: (_base, relPath) => stored.delete(Buffer.from(relPath).toString()),
  });
  t.after(() => markdownMirror.setLedger(null));
  const note = { id: 86, title: `${"a".repeat(59)}😀 party`, content: "Body" };

  write(note, "Private notes");
  write({ ...note, content: "Body v2" }, "Private notes");
  write({ ...note, content: "Body v3" }, "Private notes");

  assert.equal(fs.readdirSync(path.join(basePath, "Private notes")).length, 1);
  assert.equal(stored.size, 1);
});

test("a user's file named like a transcript isn't taken for one", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "Journal");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "2024-05-01-transcript.md"), "Notes from the call");
  const note = {
    id: 2024,
    title: "Call",
    content: "Body",
    created_at: "2026-07-21T12:00:00Z",
    transcript: JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Hi" }]),
  };

  markdownMirror.writeTranscript(note, placement("Private notes"), {});
  markdownMirror.deleteNote(2024, note);

  assert.deepEqual(fs.readdirSync(dir), ["2024-05-01-transcript.md"]);
});

test("deleting a note drops its unchanged old transcript that names speakers", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "General");
  fs.mkdirSync(dir);
  const note = {
    id: 87,
    title: "Call",
    content: "Body",
    created_at: "2026-07-21T12:00:00Z",
    transcript: JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Hi" }]),
  };
  const mappings = { speaker_0: "Ada" };
  const { formatMd } = require("../../src/helpers/transcriptFormatter");
  fs.writeFileSync(
    path.join(dir, "87-call-transcript.md"),
    formatMd(note, JSON.parse(note.transcript), mappings)
  );

  markdownMirror.legacyNoteIds(["General"]);
  markdownMirror.deleteNote(87, note, mappings);

  assert.deepEqual(fs.readdirSync(dir), []);
});

test("workspace, space and folder names stay readable on disk", (t) => {
  tempMirror(t);
  const names = ["Acme Inc.", "What's next?", "Q1: plans", " Leading space", "a/b"];

  const dirs = names.map((name) => {
    markdownMirror.ensureFolder(name);
    return path.basename(markdownMirror.getFolderPath(name));
  });

  assert.equal(new Set(dirs).size, names.length);
  for (const dir of dirs) {
    assert.doesNotMatch(dir, /^__ow-/);
    assert.doesNotMatch(dir, /[<>:"/\\|?*]|[ .]$|^ /);
  }
  assert.match(dirs[0], /^Acme Inc/);
});

test("after the old layout is checked once, a write doesn't read the user's other folders", (t) => {
  const basePath = tempMirror(t);
  fs.mkdirSync(path.join(basePath, "Recipes"));
  fs.writeFileSync(path.join(basePath, "Recipes", "soup.md"), "soup");
  markdownMirror.legacyNoteIds();
  const readdir = t.mock.method(fs, "readdirSync");

  write({ id: 88, title: "N", content: "Body" }, "Private notes");

  const readRecipes = readdir.mock.calls.some((call) =>
    String(call.arguments[0]).endsWith("Recipes")
  );
  readdir.mock.restore();
  assert.equal(readRecipes, false);
});

test(
  "a folder renamed only in case is renamed on disk too",
  { skip: !caseInsensitiveFileSystem() && "needs a case-insensitive file system" },
  (t) => {
    const basePath = tempMirror(t);
    markdownMirror.ensureFolder(placement("Private notes", "General"), 5);

    markdownMirror.moveFolderDir("Private notes/General", placement("Private notes", "general"), 5);

    assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")), ["general"]);
    assert.deepEqual(
      markdownMirror.recordedFiles().map((entry) => entry.relPath),
      ["Private notes/general"]
    );
  }
);

function caseInsensitiveFileSystem() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "OpenWhisprCaseProbe-"));
  try {
    return fs.existsSync(probe.toLowerCase()) && fs.existsSync(probe.toUpperCase());
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

test("a long title of wide characters still fits a file name", (t) => {
  const basePath = tempMirror(t);
  const note = {
    id: 89,
    title: "𝐀".repeat(70),
    content: "Body",
    created_at: "2026-07-21T12:00:00Z",
    transcript: JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Hi" }]),
  };

  write(note, "Private notes");
  markdownMirror.writeTranscript(note, placement("Private notes"), {});

  for (const name of fs.readdirSync(path.join(basePath, "Private notes"))) {
    assert.ok(Buffer.byteLength(name) <= 200, `${name.length} characters is too long`);
  }
});

test("an unchanged old file of a title ending in a space goes", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "General");
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "90-hello.md"),
    "---\nid: 90\ntitle: Hello \ntype: personal\nfolder: General\ncreated: x\nupdated: y\n---\n\nBody"
  );

  write({ id: 90, title: "Hello ", content: "Body", created_at: "x" }, "Private notes");

  assert.deepEqual(fs.readdirSync(dir), []);
});

test("an emptied old folder whose name the old mirror hashed goes too", (t) => {
  const basePath = tempMirror(t);
  const oldName = `__ow-${require("node:crypto").createHash("sha256").update("Q1: plans").digest("hex")}`;
  fs.mkdirSync(path.join(basePath, oldName));

  markdownMirror.removeEmptyOldDirs(["Q1: plans"]);

  assert.equal(fs.existsSync(path.join(basePath, oldName)), false);
});

test("a typed name that looks made safe, in any case, doesn't share a directory", (t) => {
  tempMirror(t);
  markdownMirror.ensureFolder("a/b");
  const generated = path.basename(markdownMirror.getFolderPath("a/b"));
  const typed = generated.replace(/\(([0-9a-f]{8})\)$/, (_match, hex) => `(${hex.toUpperCase()})`);
  markdownMirror.ensureFolder(typed);

  assert.notEqual(
    path.basename(markdownMirror.getFolderPath(typed)).toLowerCase(),
    generated.toLowerCase()
  );
});

test("recorded cleanup never follows a replaced ancestor directory", (t) => {
  const basePath = tempMirror(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cleanup-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  for (const edited of [false, true]) {
    const note = { id: edited ? 902 : 901, title: "Plan", content: "Body" };
    const folder = edited ? "Edited" : "Pristine";
    write(note, "Workspaces", folder, "Team");
    const original = path.join(basePath, "Workspaces", folder);
    const moved = path.join(outside, folder);
    fs.renameSync(original, moved);
    const externalFile = path.join(moved, "Team", `${note.id}-plan.md`);
    if (edited) fs.appendFileSync(externalFile, "\nmy external edit");
    const before = fs.readFileSync(externalFile, "utf8");
    fs.symlinkSync(moved, original, "dir");

    markdownMirror.deleteNote(note.id);
    markdownMirror.removeVacatedDirs();

    assert.equal(fs.readFileSync(externalFile, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.join(moved, "Team")), [`${note.id}-plan.md`]);
  }
});

test("a cached old-layout path is not cleaned through a replaced ancestor", (t) => {
  const basePath = tempMirror(t);
  const oldDir = path.join(basePath, "General");
  fs.mkdirSync(oldDir);
  const before = "---\nid: 903\ntitle: Plan\ntype: personal\nfolder: General\n---\n\nBody";
  fs.writeFileSync(path.join(oldDir, "903-plan.md"), before);
  markdownMirror.legacyNoteIds();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-old-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const moved = path.join(outside, "General");
  fs.renameSync(oldDir, moved);
  fs.symlinkSync(moved, oldDir, "dir");

  markdownMirror.deleteNote(903, { id: 903, title: "Plan", content: "Body" });

  assert.equal(fs.readFileSync(path.join(moved, "903-plan.md"), "utf8"), before);
});

for (const collisionKind of ["file", "symlink"]) {
  test(`an existing temporary ${collisionKind} is never overwritten or removed`, (t) => {
    const basePath = tempMirror(t);
    const dir = path.join(basePath, "Private notes");
    fs.mkdirSync(dir);
    const target = path.join(dir, "904-plan.md");
    const outside = path.join(basePath, "external.txt");
    fs.writeFileSync(outside, "my external file");
    const temporary = `${target}.${process.pid}.tmp`;
    if (collisionKind === "symlink") fs.symlinkSync(outside, temporary);
    else fs.writeFileSync(temporary, "my temporary file");

    write({ id: 904, title: "Plan", content: "Body" }, "Private notes");

    assert.equal(fs.readFileSync(outside, "utf8"), "my external file");
    assert.match(fs.readFileSync(target, "utf8"), /Body$/);
    assert.equal(fs.lstatSync(temporary).isSymbolicLink(), collisionKind === "symlink");
    assert.equal(
      fs.readFileSync(temporary, "utf8"),
      collisionKind === "symlink" ? "my external file" : "my temporary file"
    );
  });
}

for (const folder of ["Workspaces", ".archive"]) {
  test(`old notes in ${folder} are migrated while unrelated files stay`, (t) => {
    const basePath = tempMirror(t);
    const dir = path.join(basePath, folder);
    fs.mkdirSync(dir);
    const old = (id, body) =>
      `---\nid: ${id}\ntitle: Plan\ntype: personal\nfolder: ${folder}\n---\n\n${body}`;
    fs.writeFileSync(path.join(dir, "905-plan.md"), old(905, "Body"));
    fs.writeFileSync(path.join(dir, "906-plan.md"), old(906, "my edit"));
    fs.writeFileSync(path.join(dir, "907-user.md"), "---\ntags: [mine]\n---\n\nmy own file");
    fs.mkdirSync(path.join(dir, "User directory"));
    fs.writeFileSync(path.join(dir, "User directory", "908-plan.md"), old(908, "nested"));

    assert.deepEqual([...markdownMirror.legacyNoteIds([folder])].sort(), [905, 906]);
    write({ id: 905, title: "Plan", content: "Body" }, "Private notes");
    write({ id: 906, title: "Plan", content: "Body" }, "Private notes");
    markdownMirror.removeEmptyOldDirs([folder]);

    assert.equal(fs.existsSync(path.join(dir, "905-plan.md")), false);
    assert.equal(
      fs.readFileSync(path.join(dir, "edited-906-plan.md"), "utf8"),
      old(906, "my edit")
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "907-user.md"), "utf8"),
      "---\ntags: [mine]\n---\n\nmy own file"
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "User directory", "908-plan.md"), "utf8"),
      old(908, "nested")
    );
  });
}

for (const changedSegment of [1, 2, 3]) {
  test(
    `a populated placement directory at level ${changedSegment} adopts case-only renames`,
    { skip: !caseInsensitiveFileSystem() && "needs a case-insensitive file system" },
    (t) => {
      const basePath = tempMirror(t);
      const before = ["Workspaces", "Acme", "Engineering", "General"];
      const after = before.map((segment, index) =>
        index === changedSegment ? segment.toLowerCase() : segment
      );
      const note = { id: 909, title: "Plan", content: "Body", created_at: "x", updated_at: "y" };
      write(note, ...before);
      const userFile = path.join(basePath, ...before, "mine.txt");
      fs.writeFileSync(userFile, "keep my file");

      write(note, ...after);
      markdownMirror.removeVacatedDirs();

      assert.deepEqual(fs.readdirSync(path.join(basePath, ...after.slice(0, changedSegment))), [
        after[changedSegment],
      ]);
      assert.equal(
        fs.readFileSync(path.join(basePath, ...after, "mine.txt"), "utf8"),
        "keep my file"
      );
      assert.match(fs.readFileSync(markdownMirror.getNotePath(909), "utf8"), /Body$/);
      assert.deepEqual(
        markdownMirror.recordedFiles().map((entry) => entry.relPath),
        [`${after.join("/")}/909-plan.md`]
      );
    }
  );
}

test(
  "a differently cased mirror base still resolves and writes inside its actual directory",
  { skip: !caseInsensitiveFileSystem() && "needs a case-insensitive file system" },
  (t) => {
    const basePath = tempMirror(t);
    markdownMirror.init(basePath.toUpperCase());

    write({ id: 910, title: "Plan", content: "Body" }, "Private notes", "General");

    assert.match(
      fs.readFileSync(path.join(basePath, "Private notes", "General", "910-plan.md"), "utf8"),
      /Body$/
    );
  }
);

test(
  "a populated recorded folder case rename rebases all descendant ledger entries",
  { skip: !caseInsensitiveFileSystem() && "needs a case-insensitive file system" },
  (t) => {
    const basePath = tempMirror(t);
    const before = placement("Private notes", "General");
    const after = placement("Private notes", "general");
    markdownMirror.ensureFolder(before, 1010);
    markdownMirror.ensureFolder(placement("Private notes", "General", "Child"), 1011);
    markdownMirror.writeNote({ id: 912, title: "First", content: "Body" }, before);
    markdownMirror.writeNote({ id: 913, title: "Second", content: "Other account" }, before);

    markdownMirror.moveFolderDir("Private notes/General", after, 1010);

    assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")), ["general"]);
    assert.deepEqual(
      markdownMirror
        .recordedFiles()
        .map((entry) => entry.relPath)
        .sort(),
      [
        "Private notes/general",
        "Private notes/general/912-first.md",
        "Private notes/general/913-second.md",
        "Private notes/general/Child",
      ].sort()
    );
    assert.match(fs.readFileSync(markdownMirror.getNotePath(913), "utf8"), /Other account$/);
  }
);

test("unknown dot directories keep matching legacy-looking user files", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, ".obsidian");
  fs.mkdirSync(dir);
  const before = "---\nid: 914\ntitle: Plan\ntype: personal\nfolder: .obsidian\n---\n\nBody";
  fs.writeFileSync(path.join(dir, "914-plan.md"), before);

  assert.equal(markdownMirror.legacyNoteIds([".archive"]).has(914), false);
  write({ id: 914, title: "Plan", content: "Body" }, "Private notes");
  markdownMirror.deleteNote(914, { id: 914, title: "Plan", content: "Body" });

  assert.equal(fs.readFileSync(path.join(dir, "914-plan.md"), "utf8"), before);
});

test("a write that fails partway keeps the file's previous content and leaves nothing else", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 915, title: "Plan", content: "Body" };
  write(note, "Private notes");
  const target = markdownMirror.getNotePath(915);
  const before = fs.readFileSync(target, "utf8");
  const writeFile = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (typeof file !== "number") return writeFile(file, ...args);
    writeFile(file, "partial write");
    throw new Error("disk write failed");
  });

  write({ ...note, content: "Updated body" }, "Private notes");

  assert.equal(fs.readFileSync(target, "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")), [path.basename(target)]);
});

test("known dot folders use filesystem identity after an offline case rename", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, ".Archive");
  fs.mkdirSync(dir);
  const oldPath = path.join(dir, "916-plan.md");
  fs.writeFileSync(
    oldPath,
    "---\nid: 916\ntitle: Plan\ntype: personal\nfolder: .Archive\n---\n\nBody"
  );
  const aliasesFolder = fs.existsSync(path.join(basePath, ".archive"));

  assert.deepEqual([...markdownMirror.legacyNoteIds([".archive"])], aliasesFolder ? [916] : []);
  write({ id: 916, title: "Plan", content: "Body" }, "Private notes");

  assert.equal(fs.existsSync(oldPath), !aliasesFolder);
});

test(
  "a differently cased base preserves the existing ledger identity on upgrade",
  { skip: !caseInsensitiveFileSystem() && "needs a case-insensitive file system" },
  (t) => {
    const basePath = tempMirror(t);
    const note = { id: 917, title: "Plan", content: "Original", created_at: "x", updated_at: "y" };
    write(note, "Private notes");
    const [entry] = markdownMirror.recordedFiles();
    const configured = basePath.toUpperCase();
    const legacyBaseKey = fs.realpathSync(configured);
    const entries = new Map([
      [`${legacyBaseKey}\0${entry.relPath}`, { ...entry, basePath: legacyBaseKey }],
    ]);
    markdownMirror.setLedger({
      files: (base) => [...entries.values()].filter((stored) => stored.basePath === base),
      record: (base, stored) =>
        entries.set(`${base}\0${stored.relPath}`, { ...stored, basePath: base }),
      forget: (base, relPath) => entries.delete(`${base}\0${relPath}`),
    });
    t.after(() => markdownMirror.setLedger(null));

    markdownMirror.init(configured);

    assert.equal(markdownMirror.recordedFiles().length, 1);
    write({ ...note, content: "Updated" }, "Private notes");
    assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")), ["917-plan.md"]);
    assert.match(fs.readFileSync(markdownMirror.getNotePath(917), "utf8"), /Updated$/);
    assert.equal(entries.size, 1);
    assert.equal([...entries.values()][0].basePath, legacyBaseKey);
  }
);

test("saving a note again keeps its file, so its creation date and tags stay", (t) => {
  tempMirror(t);
  const note = { id: 91, title: "Kept identity", content: "Body" };
  write(note, "Private notes");
  const filePath = markdownMirror.getNotePath(91);
  const before = fs.statSync(filePath, { bigint: true });

  write({ ...note, content: "Body v2" }, "Private notes");

  const after = fs.statSync(filePath, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.birthtimeNs, before.birthtimeNs);
  assert.match(fs.readFileSync(filePath, "utf8"), /Body v2$/);
});

test("a save that fails partway leaves no half-written file behind to keep aside", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 92, title: "Disk full", content: "Body" };
  write(note, "Private notes");
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target, data, options) => {
    if (typeof target === "number") {
      realWrite(target, String(data).slice(0, 5), options);
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    }
    return realWrite(target, data, options);
  });

  write({ ...note, content: "Body v2" }, "Private notes");
  fs.writeFileSync.mock.restore();
  write({ ...note, content: "Body v3" }, "Private notes");

  assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")), ["92-disk-full.md"]);
  assert.match(fs.readFileSync(markdownMirror.getNotePath(92), "utf8"), /Body v3$/);
});

function callNote(id) {
  return {
    id,
    title: "Call",
    content: "Body",
    created_at: "2026-07-21T12:00:00Z",
    transcript: JSON.stringify([
      { speaker: "speaker_0", timestamp: 0, text: "Hi" },
      { speaker: "speaker_1", timestamp: 5, text: "Hello" },
    ]),
  };
}

test("an old transcript saved before its speakers were named still counts as unchanged", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "General");
  fs.mkdirSync(dir);
  const { formatMd } = require("../../src/helpers/transcriptFormatter");
  const note = callNote(93);
  const segments = JSON.parse(note.transcript);
  fs.writeFileSync(path.join(dir, "93-call-transcript.md"), formatMd(note, segments, {}));
  const partlyNamed = callNote(94);
  fs.writeFileSync(
    path.join(dir, "94-call-transcript.md"),
    formatMd(partlyNamed, segments, { speaker_0: "Ada" })
  );

  const mappings = { speaker_0: "Ada", speaker_1: "Grace" };
  markdownMirror.legacyNoteIds(["General"]);
  markdownMirror.writeTranscript(note, placement("Private notes"), mappings);
  markdownMirror.writeTranscript(partlyNamed, placement("Private notes"), mappings);

  assert.deepEqual(fs.readdirSync(dir), []);
});

test("an old transcript with a speaker renamed by hand is kept", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "General");
  fs.mkdirSync(dir);
  const { formatMd } = require("../../src/helpers/transcriptFormatter");
  const note = callNote(95);
  const handEdited = formatMd(note, JSON.parse(note.transcript), { speaker_0: "Bob" });
  fs.writeFileSync(path.join(dir, "95-call-transcript.md"), handEdited);

  markdownMirror.legacyNoteIds(["General"]);
  markdownMirror.writeTranscript(note, placement("Private notes"), { speaker_0: "Ada" });

  assert.equal(fs.readFileSync(path.join(dir, "edited-95-call-transcript.md"), "utf8"), handEdited);
});

test("on Windows, a rename refused for a moment is tried again", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 96, title: "Plan", content: "Body" };
  write(note, "Private notes");
  fs.appendFileSync(markdownMirror.getNotePath(96), "\nmine");
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", original));
  const realRename = fs.renameSync;
  let refused = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (refused < 2) {
      refused++;
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }
    return realRename(from, to);
  });

  write({ ...note, content: "Body v2" }, "Private notes");
  fs.renameSync.mock.restore();

  assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")).sort(), [
    "96-plan.md",
    "edited-96-plan.md",
  ]);
});

test("an old transcript saved before its speakers were identified counts as unchanged", (t) => {
  const basePath = tempMirror(t);
  const dir = path.join(basePath, "General");
  fs.mkdirSync(dir);
  const { formatMd } = require("../../src/helpers/transcriptFormatter");
  const before = callNote(97);
  fs.writeFileSync(
    path.join(dir, "97-call-transcript.md"),
    formatMd(before, JSON.parse(before.transcript), {})
  );
  // Identifying a speaker later writes the name into the segments themselves.
  const identified = {
    ...before,
    transcript: JSON.stringify(
      JSON.parse(before.transcript).map((segment) =>
        segment.speaker === "speaker_0" ? { ...segment, speakerName: "Ada" } : segment
      )
    ),
  };

  markdownMirror.legacyNoteIds(["General"]);
  markdownMirror.writeTranscript(identified, placement("Private notes"), {});

  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a save whose close fails gets the file's previous content back", (t) => {
  tempMirror(t);
  const note = { id: 98, title: "Deferred error", content: "Body" };
  write(note, "Private notes");
  const filePath = markdownMirror.getNotePath(98);
  const before = fs.readFileSync(filePath, "utf8");
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target, data, options) =>
    realWrite(target, typeof target === "number" ? "PART" : data, options)
  );
  const realClose = fs.closeSync;
  t.mock.method(fs, "closeSync", (descriptor) => {
    realClose(descriptor);
    throw Object.assign(new Error("deferred write error"), { code: "EIO" });
  });

  write({ ...note, content: "Body v2" }, "Private notes");
  t.mock.restoreAll();

  assert.equal(fs.readFileSync(filePath, "utf8"), before);
});

test("a dangling link at a note's path is refused even where links can be followed", (t) => {
  const basePath = tempMirror(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  const dir = path.join(basePath, "Private notes");
  fs.mkdirSync(dir);
  const outsideTarget = path.join(outsidePath, "created-through-link.md");
  fs.symlinkSync(outsideTarget, path.join(dir, "99-linked.md"));
  // Windows has no O_NOFOLLOW, so the open would follow the link.
  const realOpen = fs.openSync;
  t.mock.method(fs, "openSync", (target, flags, mode) =>
    realOpen(
      target,
      typeof flags === "number" ? flags & ~(fs.constants.O_NOFOLLOW ?? 0) : flags,
      mode
    )
  );

  write({ id: 99, title: "Linked", content: "Body" }, "Private notes");
  t.mock.restoreAll();

  assert.equal(fs.existsSync(outsideTarget), false);
});

for (const name of ["- Design", "true", "null", "2026-11-12", "123", "line\u0001one"]) {
  test(`workspace and space metadata round-trip as YAML strings: ${JSON.stringify(name)}`, (t) => {
    tempMirror(t);
    const note = { id: 920, title: "Meeting", content: "Body" };
    markdownMirror.writeNote(note, {
      segments: ["Workspaces", name, "Teamspaces", name],
      workspace: name,
      space: name,
    });
    const text = fs.readFileSync(markdownMirror.getNotePath(note.id), "utf8");
    const header = text.match(/^---\n([\s\S]*?)\n---/)[1];
    const metadata = require("js-yaml").load(header);
    assert.equal(metadata.workspace, name);
    assert.equal(metadata.space, name);
  });
}

for (const title of ["A".repeat(1000), "界".repeat(400)]) {
  test(`legacy headers over 1 KB migrate and delete (${Buffer.byteLength(title)} title bytes)`, (t) => {
    const basePath = tempMirror(t);
    const note = { id: 921, title, content: "Body", created_at: "x" };
    const oldDir = path.join(basePath, "General");
    fs.mkdirSync(oldDir);
    const oldFile = path.join(oldDir, "921-old.md");
    fs.writeFileSync(
      oldFile,
      `---\nid: 921\ntitle: ${title}\ntype: personal\nfolder: General\ncreated: x\nupdated: y\n---\n\nBody`
    );
    assert.deepEqual([...markdownMirror.legacyNoteIds(["General"])], [note.id]);
    write(note, "Private notes");
    assert.equal(fs.existsSync(oldFile), false);
    const newFile = markdownMirror.getNotePath(note.id);
    assert.ok(newFile);
    markdownMirror.deleteNote(note.id, note);
    assert.equal(fs.existsSync(newFile), false);
    assert.equal(fs.existsSync(oldFile), false);
  });
}

for (const operation of ["save", "delete"]) {
  test(`preserving an external edit on ${operation} keeps dangling symlinks`, (t) => {
    const basePath = tempMirror(t);
    const note = { id: 922, title: "Plan", content: "Body" };
    write(note, "Private notes");
    const notePath = markdownMirror.getNotePath(note.id);
    fs.appendFileSync(notePath, "\nmy external edit");
    const keptPath = path.join(basePath, "Private notes", "edited-922-plan.md");
    fs.symlinkSync("unavailable.md", keptPath, "file");
    if (operation === "save") write({ ...note, content: "Updated" }, "Private notes");
    else markdownMirror.deleteNote(note.id, note);
    assert.equal(fs.lstatSync(keptPath).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(keptPath), "unavailable.md");
    assert.match(
      fs.readFileSync(path.join(basePath, "Private notes", "edited-2-922-plan.md"), "utf8"),
      /my external edit$/
    );
  });
}

test("retitling a note onto its own unchanged transcript keeps only the new pair", (t) => {
  const basePath = tempMirror(t);
  const note = callNote(923);
  write(note, "Private notes");
  markdownMirror.writeTranscript(note, placement("Private notes"), {});
  const renamed = { ...note, title: "Call transcript" };
  write(renamed, "Private notes");
  markdownMirror.writeTranscript(renamed, placement("Private notes"), {});
  assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")).sort(), [
    "923-call-transcript-transcript.md",
    "923-call-transcript.md",
  ]);
  markdownMirror.deleteNote(note.id, renamed);
  assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")), []);
});

test("retitling onto an externally edited transcript preserves its changes", (t) => {
  const basePath = tempMirror(t);
  const note = callNote(924);
  write(note, "Private notes");
  markdownMirror.writeTranscript(note, placement("Private notes"), {});
  fs.appendFileSync(path.join(basePath, "Private notes", "924-call-transcript.md"), "\nmy edit");
  const renamed = { ...note, title: "Call transcript" };
  write(renamed, "Private notes");
  markdownMirror.writeTranscript(renamed, placement("Private notes"), {});
  markdownMirror.deleteNote(note.id, renamed);
  const dir = path.join(basePath, "Private notes");
  assert.deepEqual(fs.readdirSync(dir), ["edited-924-call-transcript.md"]);
  assert.match(
    fs.readFileSync(path.join(dir, "edited-924-call-transcript.md"), "utf8"),
    /my edit$/
  );
});

test("legacy migration leaves unrelated note IDs and transcript-shaped user files alone", (t) => {
  const basePath = tempMirror(t);
  const fixtures = [
    ["Reading", "5-reading-list.md", "---\nid: 5\ntags: [books]\n---\n\nMy reading list"],
    ["Meetings", "2024-03-12-standup-transcript.md", "# Standup\n\n**2024-03-12**\n\nMy meeting"],
  ];
  for (const [folder, name, content] of fixtures) {
    fs.mkdirSync(path.join(basePath, folder));
    fs.writeFileSync(path.join(basePath, folder, name), content);
  }
  assert.deepEqual([...markdownMirror.legacyNoteIds(["General"])], []);
  for (const id of [5, 2024]) {
    const note = callNote(id);
    write(note, "Private notes");
    markdownMirror.writeTranscript(note, placement("Private notes"), {});
    markdownMirror.deleteNote(id, note);
  }
  for (const [folder, name, content] of fixtures) {
    assert.deepEqual(fs.readdirSync(path.join(basePath, folder)), [name]);
    assert.equal(fs.readFileSync(path.join(basePath, folder, name), "utf8"), content);
  }
});

test("copies of new-layout private notes are not legacy files", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 925, title: "Plan", content: "Body" };
  markdownMirror.writeNote(note, { segments: ["Private notes"], space: "Private" });
  const filePath = markdownMirror.getNotePath(note.id);
  const copy = path.join(basePath, "Private notes", "925-plan copy.md");
  fs.copyFileSync(filePath, copy);
  markdownMirror.legacyNoteIds(["General"]);
  markdownMirror.deleteNote(note.id, note);
  assert.equal(fs.readFileSync(copy, "utf8").endsWith("Body"), true);
  assert.deepEqual(fs.readdirSync(path.dirname(copy)), ["925-plan copy.md"]);
});

test("legacy note headers discover folders renamed while mirroring was disabled", (t) => {
  const basePath = tempMirror(t);
  const oldDir = path.join(basePath, "Before rename");
  fs.mkdirSync(oldDir);
  const note = callNote(926);
  fs.writeFileSync(
    path.join(oldDir, "926-call.md"),
    `---\nid: 926\ntitle: Call\ntype: personal\nfolder: Before rename\ncreated: ${note.created_at}\nupdated: y\n---\n\nBody`
  );
  fs.writeFileSync(
    path.join(oldDir, "926-call-transcript.md"),
    require("../../src/helpers/transcriptFormatter").formatMd(note, JSON.parse(note.transcript), {})
  );
  assert.deepEqual([...markdownMirror.legacyNoteIds(["After rename"])], [note.id]);
  write(note, "Private notes", "After rename");
  markdownMirror.writeTranscript(note, placement("Private notes", "After rename"), {});
  assert.deepEqual(fs.readdirSync(oldDir), []);
});

test("creating a replacement never truncates a file that appeared after the ownership check", (t) => {
  const basePath = tempMirror(t);
  const note = { id: 927, title: "Plan", content: "Body" };
  write(note, "Private notes");
  const filePath = markdownMirror.getNotePath(note.id);
  fs.appendFileSync(filePath, "\nmy original external edit");
  const canonicalPath = fs.realpathSync.native(filePath);
  const open = fs.openSync;
  let inserted = false;
  t.mock.method(fs, "openSync", (target, flags, mode) => {
    if (
      target === canonicalPath &&
      typeof flags === "number" &&
      (flags & fs.constants.O_WRONLY) !== 0 &&
      !inserted
    ) {
      inserted = true;
      fs.writeFileSync(filePath, "a file created by another process");
    }
    return open(target, flags, mode);
  });
  write({ ...note, content: "Updated" }, "Private notes");
  fs.openSync.mock.restore();
  assert.equal(inserted, true);
  assert.equal(fs.readFileSync(filePath, "utf8"), "a file created by another process");
  assert.match(
    fs.readFileSync(path.join(basePath, "Private notes", "edited-927-plan.md"), "utf8"),
    /my original external edit$/
  );
});

for (const title of ["A".repeat(1500), "界".repeat(500)]) {
  test(`long legacy transcript titles migrate with their note (${Buffer.byteLength(title)} bytes)`, (t) => {
    const basePath = tempMirror(t);
    const note = { ...callNote(928), title };
    const oldDir = path.join(basePath, "General");
    fs.mkdirSync(oldDir);
    const transcriptFile = path.join(oldDir, "928-call-transcript.md");
    fs.writeFileSync(
      transcriptFile,
      require("../../src/helpers/transcriptFormatter").formatMd(
        note,
        JSON.parse(note.transcript),
        {}
      )
    );
    assert.deepEqual([...markdownMirror.legacyNoteIds(["General"])], [note.id]);
    write(note, "Private notes");
    markdownMirror.writeTranscript(note, placement("Private notes"), {});
    assert.equal(fs.existsSync(transcriptFile), false);
    markdownMirror.deleteNote(note.id, note);
    assert.deepEqual(fs.readdirSync(path.join(basePath, "Private notes")), []);
  });
}
