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

function setup(t, knownSubfolders = []) {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => {
    fs.rmSync(basePath, { recursive: true, force: true });
    markdownMirror.setSubfolderResolver(null);
  });
  markdownMirror.init(basePath);
  markdownMirror.setSubfolderResolver(() => knownSubfolders);
  return basePath;
}

const write = (...segments) => {
  fs.mkdirSync(path.dirname(path.join(...segments)), { recursive: true });
  fs.writeFileSync(path.join(...segments), "the user's own");
};
const read = (...segments) => fs.readFileSync(path.join(...segments), "utf-8");
const tree = (dirPath, prefix = "") =>
  fs
    .readdirSync(dirPath, { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.join(prefix, entry.name);
      return entry.isDirectory() ? [name, ...tree(path.join(dirPath, entry.name), name)] : [name];
    })
    .sort();

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

  markdownMirror.deleteFolder("team/docs", [14]);

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

test("subfolder writes and moves reject a symlinked parent that resolves outside the mirror", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  fs.symlinkSync(outsidePath, path.join(basePath, "linked"), "dir");

  markdownMirror.init(basePath);
  markdownMirror.writeNote({ id: 18, title: "Escaped", content: "Body" }, ["linked", "Q2"]);
  markdownMirror.writeNote({ id: 19, title: "Kept", content: "Body" }, "Q1");
  assert.equal(markdownMirror.renameFolder("Q1", ["linked", "Q1"]), false);

  assert.deepEqual(fs.readdirSync(outsidePath), []);
  assert.equal(markdownMirror.getNotePath(19), path.join(basePath, "Q1", "19-kept.md"));
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

  markdownMirror.deleteFolder("Archive", [30]);
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

test("a subfolder mirrors inside its parent's directory and moves with it", (t) => {
  const basePath = setup(t, [
    ["Client A", "Q1"],
    ["Client B", "Q1"],
  ]);

  const note = { id: 21, title: "Budget", content: "Numbers" };
  markdownMirror.writeNote(note, ["Client A", "Q1"]);
  const nestedPath = path.join(basePath, "Client A", "Q1", "21-budget.md");
  assert.equal(fs.existsSync(nestedPath), true);
  assert.match(fs.readFileSync(nestedPath, "utf-8"), /^folder: Client A\/Q1$/m);
  assert.equal(markdownMirror.getNotePath(21), nestedPath);

  markdownMirror.renameFolder("Client A", "Client B");
  const renamedPath = path.join(basePath, "Client B", "Q1", "21-budget.md");
  assert.equal(
    markdownMirror.getNotePath(21),
    renamedPath,
    "renaming a parent carries its subfolders"
  );

  markdownMirror.renameFolder(["Client B", "Q1"], "Q1");
  assert.equal(markdownMirror.getNotePath(21), path.join(basePath, "Q1", "21-budget.md"));

  markdownMirror.renameFolder("Q1", ["Client B", "Q1"]);
  markdownMirror.writeNote(note, "Personal");
  assert.equal(markdownMirror.getNotePath(21), path.join(basePath, "Personal", "21-budget.md"));
  assert.equal(
    fs.readdirSync(path.join(basePath, "Client B", "Q1")).length,
    0,
    "the stale nested copy is removed"
  );
});

test("each subfolder segment gets a portable directory name", (t) => {
  const basePath = setup(t, [["CON", "../up"]]);

  markdownMirror.writeNote({ id: 22, title: "Plan", content: "Body" }, ["CON", "../up"]);
  const notePath = markdownMirror.getNotePath(22);
  assert.ok(notePath.startsWith(basePath + path.sep));
  const [parentDir, childDir] = path.relative(basePath, path.dirname(notePath)).split(path.sep);
  assert.match(parentDir, /^__ow-[0-9a-f]{64}$/);
  assert.match(childDir, /^__ow-[0-9a-f]{64}$/);
});

test("renaming a folder into a shared directory merges same-named subfolders", (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  markdownMirror.init(basePath);

  markdownMirror.writeNote({ id: 31, title: "Plan", content: "Body" }, ["Client A", "Q1"]);
  markdownMirror.writeNote({ id: 32, title: "Roadmap", content: "Body" }, ["Client B", "Q1"]);
  markdownMirror.renameFolder("Client A", "Client B");

  assert.deepEqual(fs.readdirSync(path.join(basePath, "Client B", "Q1")).sort(), [
    "31-plan.md",
    "32-roadmap.md",
  ]);
  assert.equal(fs.existsSync(path.join(basePath, "Client A")), false);
});

test("deleting a folder removes only directories left empty, bottom-up", (t) => {
  const basePath = setup(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  write(outsidePath, "kept.txt");

  fs.mkdirSync(path.join(basePath, "Emptied", "Q", "deeper"), { recursive: true });
  markdownMirror.deleteFolder("Emptied");
  assert.equal(fs.existsSync(path.join(basePath, "Emptied")), false);

  write(basePath, "P", "contract.pdf");
  write(basePath, "P", "Q", "photo.png");
  fs.mkdirSync(path.join(basePath, "P", "R", "S"), { recursive: true });
  fs.mkdirSync(path.join(basePath, "P", "T"), { recursive: true });
  fs.symlinkSync(outsidePath, path.join(basePath, "P", "T", "link"), "dir");
  markdownMirror.deleteFolder("P");

  assert.deepEqual(tree(path.join(basePath, "P")), [
    "Q",
    path.join("Q", "photo.png"),
    "T",
    path.join("T", "link"),
    "contract.pdf",
  ]);
  assert.deepEqual(fs.readdirSync(outsidePath), ["kept.txt"], "never reached through the link");
});

test("deleting a folder removes the given notes' files, transcripts too, and no others", (t) => {
  const basePath = setup(t);
  const note = {
    id: 40,
    title: "Plan",
    content: "Body",
    transcript: JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Hello." }]),
  };
  markdownMirror.writeNote(note, "P");
  markdownMirror.writeTranscript(note, "P", {});
  markdownMirror.writeNote({ id: 41, title: "Other", content: "Body" }, "P");
  write(basePath, "P", "40-my-own-notes.txt");
  write(basePath, "P", "40-not-frontmatter.md");

  markdownMirror.deleteFolder("P", [40]);

  assert.deepEqual(tree(path.join(basePath, "P")), [
    "40-my-own-notes.txt",
    "40-not-frontmatter.md",
    "41-other.md",
  ]);
});

test("a directory that won't go doesn't stop the rest of a folder delete", (t) => {
  const basePath = setup(t);
  fs.mkdirSync(path.join(basePath, "P", "busy"), { recursive: true });
  fs.mkdirSync(path.join(basePath, "P", "idle"), { recursive: true });
  const realRmdir = fs.rmdirSync;
  t.mock.method(fs, "rmdirSync", (target) => {
    if (target.endsWith("busy")) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    return realRmdir(target);
  });

  markdownMirror.deleteFolder("P");

  assert.deepEqual(tree(path.join(basePath, "P")), ["busy"]);
});

test("a merge moves what fits and overwrites nothing, leaving the rest in the source", (t) => {
  const basePath = setup(t);
  markdownMirror.writeNote({ id: 50, title: "Moved", content: "Body" }, "A");
  markdownMirror.writeNote({ id: 51, title: "Stays", content: "Body" }, "B");
  fs.writeFileSync(path.join(basePath, "A", "README.md"), "A's readme");
  fs.writeFileSync(path.join(basePath, "B", "README.md"), "B's readme");
  fs.mkdirSync(path.join(basePath, "A", "docs"));
  fs.writeFileSync(path.join(basePath, "A", "docs", "plan.txt"), "A's plan");
  fs.writeFileSync(path.join(basePath, "A", "docs", "new.txt"), "A's new");
  fs.mkdirSync(path.join(basePath, "B", "docs"));
  fs.writeFileSync(path.join(basePath, "B", "docs", "plan.txt"), "B's plan");

  assert.equal(markdownMirror.renameFolder("A", "B"), false);

  assert.equal(read(basePath, "B", "README.md"), "B's readme");
  assert.equal(read(basePath, "B", "docs", "plan.txt"), "B's plan");
  assert.equal(read(basePath, "B", "docs", "new.txt"), "A's new");
  assert.ok(fs.existsSync(path.join(basePath, "B", "50-moved.md")));
  assert.deepEqual(tree(path.join(basePath, "A")), [
    "README.md",
    "docs",
    path.join("docs", "plan.txt"),
  ]);
  assert.equal(read(basePath, "A", "README.md"), "A's readme");
});

test("a merge with nothing in the way removes the source and reports the move", (t) => {
  const basePath = setup(t);
  markdownMirror.writeNote({ id: 52, title: "Moved", content: "Body" }, ["A", "Q"]);
  markdownMirror.writeNote({ id: 53, title: "Stays", content: "Body" }, ["B", "Q"]);

  assert.equal(markdownMirror.renameFolder("A", "B"), true);

  assert.equal(fs.existsSync(path.join(basePath, "A")), false);
  assert.deepEqual(tree(path.join(basePath, "B", "Q")), ["52-moved.md", "53-stays.md"]);
});

test("a merge never passes through a symlink at the destination", (t) => {
  const basePath = setup(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  markdownMirror.writeNote({ id: 54, title: "Inside", content: "Body" }, ["P", "Q"]);
  fs.mkdirSync(path.join(basePath, "R"));
  fs.symlinkSync(outsidePath, path.join(basePath, "R", "Q"), "dir");

  assert.equal(markdownMirror.renameFolder("P", "R"), false);

  assert.deepEqual(fs.readdirSync(outsidePath), []);
  assert.deepEqual(tree(path.join(basePath, "P", "Q")), ["54-inside.md"]);
});

test("a merge keeps the same-named note copy at the destination and the source's until a write", (t) => {
  const basePath = setup(t);
  markdownMirror.writeNote({ id: 55, title: "Plan", content: "Source" }, "A");
  fs.mkdirSync(path.join(basePath, "B"));
  fs.writeFileSync(path.join(basePath, "B", "55-plan.md"), "---\nid: 55\n---\nDestination");

  assert.equal(markdownMirror.renameFolder("A", "B"), false);
  assert.match(read(basePath, "B", "55-plan.md"), /Destination$/);
  assert.ok(fs.existsSync(path.join(basePath, "A", "55-plan.md")));

  markdownMirror.writeNote({ id: 55, title: "Plan", content: "Current" }, "B");
  assert.equal(fs.existsSync(path.join(basePath, "A", "55-plan.md")), false);
  assert.match(read(basePath, "B", "55-plan.md"), /Current$/);
});

test("a move that fails for one entry leaves it behind and reports the failure", (t) => {
  const basePath = setup(t);
  write(basePath, "A", "stuck.pdf");
  write(basePath, "A", "free.pdf");
  fs.mkdirSync(path.join(basePath, "B"));
  const realRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (from.endsWith("stuck.pdf")) {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    }
    return realRename(from, to);
  });

  assert.equal(markdownMirror.renameFolder("A", "B"), false);

  assert.deepEqual(tree(path.join(basePath, "A")), ["stuck.pdf"]);
  assert.deepEqual(tree(path.join(basePath, "B")), ["free.pdf"]);
});

test("a merge into its own subdirectory ends and loses nothing", (t) => {
  const basePath = setup(t);
  write(basePath, "A", "file.txt");
  write(basePath, "A", "A", "A", "deep.txt");

  markdownMirror.renameFolder("A", ["A", "A"]);

  const files = tree(path.join(basePath, "A")).filter((entry) => entry.endsWith(".txt"));
  assert.equal(files.length, 2);
});

test("a directory outside the known subfolders keeps the user's copies of a note", (t) => {
  const basePath = setup(t, [["P", "Known"]]);
  const note = { id: 12, title: "Foo", content: "Body" };
  const known = { id: 13, title: "Bar", content: "Body" };
  markdownMirror.writeNote(note, "P");
  markdownMirror.writeNote(known, ["P", "Known"]);
  fs.mkdirSync(path.join(basePath, "P", "archive"));
  const snapshotPath = path.join(basePath, "P", "archive", "12-foo-2026-snapshot.md");
  fs.copyFileSync(path.join(basePath, "P", "12-foo.md"), snapshotPath);

  markdownMirror.writeNote(note, "P");
  assert.ok(fs.existsSync(snapshotPath), "a save leaves it");
  assert.equal(markdownMirror.getNotePath(12), path.join(basePath, "P", "12-foo.md"));

  markdownMirror.deleteNote(12);
  assert.ok(fs.existsSync(snapshotPath), "deleting the note leaves it");
  assert.equal(markdownMirror.getNotePath(12), null);

  assert.equal(markdownMirror.getNotePath(13), path.join(basePath, "P", "Known", "13-bar.md"));
  markdownMirror.deleteNote(13);
  assert.equal(markdownMirror.getNotePath(13), null);
});

test("with no resolver, or one that fails, only the top level is scanned", (t) => {
  const basePath = setup(t);
  markdownMirror.writeNote({ id: 12, title: "Foo", content: "Body" }, ["P", "Q"]);
  markdownMirror.writeNote({ id: 13, title: "Bar", content: "Body" }, "Top");
  const nestedPath = path.join(basePath, "P", "Q", "12-foo.md");

  for (const resolver of [
    null,
    () => {
      throw new Error("database closed");
    },
  ]) {
    markdownMirror.setSubfolderResolver(resolver);
    assert.equal(markdownMirror.getNotePath(12), null);
    assert.equal(markdownMirror.getNotePath(13), path.join(basePath, "Top", "13-bar.md"));
  }
  assert.ok(fs.existsSync(nestedPath));
});

test("a known subfolder is found whichever way the file system folds its name", (t) => {
  const basePath = setup(t, [
    ["Straße", "Q"],
    ["STRASSE", "Q"],
  ]);
  markdownMirror.writeNote({ id: 60, title: "Plan", content: "Body" }, ["Straße", "Q"]);

  assert.equal(
    markdownMirror.getNotePath(60),
    path.join(basePath, "Straße", "Q", "60-plan.md"),
    "reported once, under the first name that reaches it"
  );
  markdownMirror.deleteNote(60);
  assert.equal(markdownMirror.getNotePath(60), null);
});

test("a symlinked parent never makes a subfolder scannable", (t) => {
  const basePath = setup(t, [["linked", "Q"]]);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outsidePath, "Q"));
  fs.writeFileSync(path.join(outsidePath, "Q", "70-plan.md"), "---\nid: 70\n---\n");
  fs.symlinkSync(outsidePath, path.join(basePath, "linked"), "dir");

  markdownMirror.deleteNote(70);

  assert.deepEqual(fs.readdirSync(path.join(outsidePath, "Q")), ["70-plan.md"]);
});

test("a folder's directory id says when two names are one directory", (t) => {
  const basePath = setup(t);
  assert.equal(markdownMirror.folderDirectoryId("Missing"), null);

  markdownMirror.ensureFolder("Straße");
  markdownMirror.ensureFolder("Other");
  const folded = fs.existsSync(path.join(basePath, "STRASSE"));
  assert.equal(
    markdownMirror.folderDirectoryId("STRASSE"),
    folded ? markdownMirror.folderDirectoryId("Straße") : null
  );
  assert.notEqual(
    markdownMirror.folderDirectoryId("Other"),
    markdownMirror.folderDirectoryId("Straße")
  );
  assert.match(markdownMirror.folderDirectoryId("Other"), /^\d+:\d+$/);
});

test("a case-only rename moves the folder rather than merging it into itself", (t) => {
  const basePath = setup(t);
  markdownMirror.writeNote({ id: 61, title: "Plan", content: "Body" }, "plans");

  assert.equal(markdownMirror.renameFolder("plans", "Plans"), true);

  assert.deepEqual(fs.readdirSync(basePath), ["Plans"]);
  assert.deepEqual(tree(path.join(basePath, "Plans")), ["61-plan.md"]);
});

test("looking for a note's files only examines names with its prefix", (t) => {
  const basePath = setup(t);
  markdownMirror.ensureFolder("Busy");
  for (let index = 100; index < 140; index++) {
    write(basePath, "Busy", `${index}-other-transcript.md`);
  }
  write(basePath, "Busy", "7-mine-transcript.md");
  const lstatSync = t.mock.method(fs, "lstatSync");

  assert.deepEqual(
    markdownMirror._globTranscriptFiles(7).map((file) => path.basename(file)),
    ["7-mine-transcript.md"]
  );

  const examined = lstatSync.mock.calls.filter((call) =>
    String(call.arguments[0]).endsWith("-other-transcript.md")
  );
  assert.equal(examined.length, 0);
});
