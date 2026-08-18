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
