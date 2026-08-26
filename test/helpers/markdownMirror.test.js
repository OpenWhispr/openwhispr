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

  markdownMirror.deleteFolder("team/docs");

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
  const folderNames = ["CON", "NUL.txt", "folder.", "folder "];

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
    assert.doesNotMatch(diskName, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i);
    assert.doesNotMatch(diskName, /[ .]$/);
  }
});

test("portable folders still support the normal ensure, rename, and delete journey", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  markdownMirror.init(basePath);
  markdownMirror.ensureFolder("Research");
  markdownMirror.writeNote({ id: 30, title: "Sources", content: "Body" }, "Research");
  markdownMirror.renameFolder("Research", "Archive");

  assert.equal(markdownMirror.getFolderPath("Research"), null);
  assert.equal(markdownMirror.getFolderPath("Archive"), path.join(basePath, "Archive"));
  assert.equal(fs.existsSync(path.join(basePath, "Archive", "30-sources.md")), true);

  markdownMirror.deleteFolder("Archive");
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
