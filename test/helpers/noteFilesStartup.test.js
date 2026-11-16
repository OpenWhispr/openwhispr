const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return { app: { isReady: () => false } };
  return originalLoad.call(this, request, parent, isMain);
};
let createNoteFilesSync;
try {
  ({ createNoteFilesSync } = require("../../src/helpers/noteFilesSync"));
} finally {
  Module._load = originalLoad;
}

function markdownFiles(basePath) {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) found.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(basePath);
  return found;
}

function createMirror(basePath) {
  const entries = new Map();
  const state = {
    notes: [
      {
        id: 7,
        title: "Standup",
        content: "saved while the panel was closed",
        space_id: 1,
        folder_id: null,
        account_id: "a",
        deleted_at: null,
      },
    ],
  };
  const database = {
    getMirrorContainers: () => ({
      spaces: [{ id: 1, kind: "private", name: "Private", workspace_id: null }],
      folders: [],
      workspaceNames: {},
    }),
    getMirrorFiles: (base, ownerId) =>
      [...entries.values()].filter(
        (entry) => entry.base === base && (ownerId === undefined || entry.ownerId === ownerId)
      ),
    recordMirrorFile: (base, entry) => entries.set(`${base}\0${entry.relPath}`, { base, ...entry }),
    forgetMirrorFile: (base, relPath) => entries.delete(`${base}\0${relPath}`),
    getLegacyMirrorFolderNames: () => [],
    getMirrorNoteSummaries: () => state.notes,
    getExistingNoteIds: (ids) =>
      state.notes.filter((note) => ids.includes(note.id)).map((note) => note.id),
    getNotesForMirror: (ids) => state.notes.filter((note) => ids.includes(note.id)),
    getNotes: () => state.notes,
  };
  return createNoteFilesSync({
    getDatabase: () => database,
    getSpeakerMappings: () => ({}),
  });
}

test("a note saved while the mirror is off is not a file", async () => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-startup-"));
  const sync = createMirror(basePath);
  try {
    await sync.flush();
    assert.deepEqual(markdownFiles(basePath), []);
    assert.equal(sync.enabled, false);
  } finally {
    sync.disable();
    fs.rmSync(basePath, { recursive: true, force: true });
  }
});

test("the saved setting requests the mirror, and that request writes the missed note", async () => {
  const { requestSavedNoteFiles } = require("../../src/helpers/noteFilesStartup");
  const calls = [];
  const recording = {
    noteFilesSetEnabled: (...args) => {
      calls.push(args);
    },
  };
  assert.equal(
    requestSavedNoteFiles({ noteFilesEnabled: false, noteFilesPath: "D:\\notes" }, recording),
    false
  );
  assert.equal(
    requestSavedNoteFiles({ noteFilesEnabled: true, noteFilesPath: "" }, recording),
    true
  );
  assert.deepEqual(calls, [[true, undefined, { skipRebuild: true }]]);

  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-startup-"));
  const sync = createMirror(basePath);
  try {
    const requested = requestSavedNoteFiles(
      { noteFilesEnabled: true, noteFilesPath: basePath },
      {
        noteFilesSetEnabled: (enabled, customPath, options) => {
          assert.equal(enabled, true);
          assert.deepEqual(options, { skipRebuild: true });
          return sync.enable(customPath, options);
        },
      }
    );
    assert.equal(requested, true);
    assert.equal(sync.enabled, true);
    await sync.flush();
    assert.match(markdownFiles(basePath).join("\n"), /saved while the panel was closed/);

    const entry = fs.readFileSync(path.join(__dirname, "../../src/main.jsx"), "utf8");
    assert.match(entry, /requestSavedNoteFiles\(/);
  } finally {
    sync.disable();
    fs.rmSync(basePath, { recursive: true, force: true });
  }
});
