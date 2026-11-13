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

async function createFixture(t) {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-batch-"));
  const entries = new Map();
  const state = { notes: [], accountId: "a", writtenNoteIds: [] };
  const containers = {
    spaces: [{ id: 1, kind: "private", name: "Private", workspace_id: null }],
    folders: [],
    workspaceNames: {},
  };
  const inScope = (note) => note.account_id === state.accountId;
  const database = {
    getMirrorContainers: () => containers,
    getMirrorFiles: (base, ownerId) =>
      [...entries.values()].filter(
        (entry) => entry.base === base && (ownerId === undefined || entry.ownerId === ownerId)
      ),
    recordMirrorFile: (base, entry) => {
      entries.set(`${base}\0${entry.relPath}`, { base, ...entry });
      if (entry.kind === "note") state.writtenNoteIds.push(entry.ownerId);
    },
    forgetMirrorFile: (base, relPath) => entries.delete(`${base}\0${relPath}`),
    getLegacyMirrorFolderNames: () => [],
    getMirrorNoteSummaries: () => state.notes.filter(inScope),
    getExistingNoteIds: (ids) =>
      state.notes.filter((note) => ids.includes(note.id)).map((note) => note.id),
    getNotesForMirror: (ids) =>
      state.notes.filter((note) => ids.includes(note.id) && inScope(note)),
    getNotes: () => state.notes.filter(inScope),
  };
  const sync = createNoteFilesSync({ getDatabase: () => database, getSpeakerMappings: () => ({}) });
  await sync.enable(basePath, { skipRebuild: true });
  await sync.flush();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(async () => {
    sync.disable();
    await sync.flush();
    fs.rmSync(basePath, { recursive: true, force: true });
  });
  const populate = () => {
    state.notes = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      title: `Note ${index + 1}`,
      content: `Body ${index + 1}`,
      space_id: 1,
      folder_id: null,
      account_id: "a",
      deleted_at: null,
    }));
    for (const note of state.notes) sync.queueNote(note.id);
  };
  const files = () => {
    const directory = path.join(basePath, "Private notes");
    return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  };
  const readNote = (id) =>
    fs.readFileSync(path.join(basePath, "Private notes", `${id}-note-${id}.md`), "utf8");
  return { sync, state, populate, files, readNote, basePath };
}

test("a large pulled-note batch yields before writing every file", async (t) => {
  const { sync, state, populate, files } = await createFixture(t);
  populate();
  sync.queueNote(120);
  t.mock.timers.tick(1000);

  assert.ok(files().length > 0, "the timer begins writing the batch");
  assert.ok(files().length < 120, "other main-process work can run before the batch finishes");

  for (let turn = 0; turn < 120 && files().length < 120; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(files().length, 120);
  await sync.flush();
  assert.equal(state.writtenNoteIds.length, 120, "queued ids are consumed once");
  assert.equal(new Set(state.writtenNoteIds).size, 120);
});

test("a synchronous flush drains a suspended batch and includes newer updates", async (t) => {
  const { sync, state, populate, files, readNote } = await createFixture(t);
  populate();
  t.mock.timers.tick(1000);
  assert.ok(files().length < 120, "the batch is suspended between chunks");
  state.notes[0].content = "Latest first note";
  state.notes[119].content = "Latest last note";
  sync.queueNote(1);

  sync.flushSync();
  assert.equal(files().length, 120);
  assert.match(readNote(1), /Latest first note$/);
  assert.match(readNote(120), /Latest last note$/);
  await sync.flush();
  assert.equal(files().length, 120);
  assert.match(readNote(1), /Latest first note$/);
  assert.match(readNote(120), /Latest last note$/);
  assert.equal(
    state.writtenNoteIds.length,
    121,
    "resuming does not repeat synchronously drained work"
  );
});

test("disabling a suspended batch cancels its remaining writes", async (t) => {
  const { sync, populate, files } = await createFixture(t);
  populate();
  t.mock.timers.tick(1000);
  const written = files().length;
  assert.ok(written < 120, "the batch is suspended between chunks");

  sync.disable();
  await new Promise((resolve) => setImmediate(resolve));
  await sync.flush();

  assert.equal(files().length, written);
});

test("an account switch drains old notes before a new account queues updates", async (t) => {
  const { sync, state, populate, files, readNote } = await createFixture(t);
  populate();
  t.mock.timers.tick(1000);
  assert.ok(files().length < 120, "the old account's batch is suspended");

  sync.flushSync();
  state.accountId = "b";
  state.notes.push({
    id: 201,
    title: "Note 201",
    content: "First body",
    space_id: 1,
    folder_id: null,
    account_id: "b",
    deleted_at: null,
  });
  sync.accountChanged();
  state.notes[120].content = "New account's latest body";
  sync.queueNote(201);
  state.notes[119].content = "Out-of-scope update";

  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await sync.flush();

  assert.equal(files().length, 121);
  assert.match(readNote(120), /Body 120$/);
  assert.match(readNote(201), /New account's latest body$/);
});

test("a path change resumes queued updates only in the new mirror", async (t) => {
  const { sync, state, populate, files, readNote, basePath } = await createFixture(t);
  populate();
  t.mock.timers.tick(1000);
  const originalCount = files().length;
  assert.ok(originalCount < 120, "the batch is suspended before the path changes");
  const newPath = path.join(basePath, "new-mirror");

  await sync.setPath(newPath);
  state.notes[119].content = "Body after moving the mirror";
  sync.queueNote(120);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await sync.flush();

  assert.equal(files().length, originalCount);
  assert.match(readNote(1), /Body 1$/);
  const newDirectory = path.join(newPath, "Private notes");
  assert.equal(fs.readdirSync(newDirectory).length, 120);
  assert.match(
    fs.readFileSync(path.join(newDirectory, "120-note-120.md"), "utf8"),
    /Body after moving the mirror$/
  );
});
