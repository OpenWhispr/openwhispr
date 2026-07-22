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
  assert.match(fs.readFileSync(notePath, "utf8"), /Updated notes$/);
});
