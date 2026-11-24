// Subfolders in the note files mirror: the real coordinator (noteFilesSync) and
// mirror against a temp directory, over an in-memory database that can hold
// several accounts and parent links the real database would refuse (loops,
// parents that are gone). A subfolder's directory sits inside its parent's, and
// no change to either may lose a note's file or one of the user's.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return { app: { isReady: () => false } };
  if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
  return originalLoad.call(this, request, parent, isMain);
};
let createNoteFilesSync;
let markdownMirror;
try {
  ({ createNoteFilesSync } = require("../../src/helpers/noteFilesSync"));
  markdownMirror = require("../../src/helpers/markdownMirror");
} finally {
  Module._load = originalLoad;
}

const PRIVATE = 1;
const TEAM = 2;

async function createFixture(t, { folders = [], notes = [], accountId = "a1" } = {}) {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-subfolders-"));
  const entries = new Map();
  const state = {
    accountId,
    spaces: [
      { id: PRIVATE, kind: "private", name: "Private", workspace_id: null },
      { id: TEAM, kind: "team", name: "Growth", workspace_id: null },
    ],
    folders: folders.map((row) => ({ account_id: null, parent_folder_id: null, ...row })),
    notes: notes.map((row) => ({
      content: `${row.title} body`,
      account_id: accountId,
      deleted_at: null,
      ...row,
    })),
  };
  const inScope = (note) => note.account_id === state.accountId;
  const database = {
    getMirrorContainers: () =>
      structuredClone({ spaces: state.spaces, folders: state.folders, workspaceNames: {} }),
    getMirrorFiles: (base, ownerId) =>
      [...entries.values()].filter(
        (entry) => entry.base === base && (ownerId === undefined || entry.ownerId === ownerId)
      ),
    recordMirrorFile: (base, entry) => entries.set(`${base}\0${entry.relPath}`, { base, ...entry }),
    forgetMirrorFile: (base, relPath) => entries.delete(`${base}\0${relPath}`),
    getLegacyMirrorFolderNames: () => state.folders.map((row) => row.name),
    getMirrorNoteSummaries: () =>
      state.notes
        .filter((note) => !note.deleted_at && inScope(note))
        .map(({ id, title, folder_id, space_id }) => ({ id, title, folder_id, space_id })),
    getExistingNoteIds: (ids) =>
      state.notes.filter((note) => ids.includes(note.id)).map((note) => note.id),
    getNotesForMirror: (ids) =>
      structuredClone(state.notes.filter((note) => ids.includes(note.id) && inScope(note))),
    getNotes: () =>
      structuredClone(state.notes.filter((note) => !note.deleted_at && inScope(note))),
  };
  const sync = createNoteFilesSync({ getDatabase: () => database, getSpeakerMappings: () => ({}) });
  await sync.enable(basePath);
  await sync.flush();
  t.after(async () => {
    sync.disable();
    await sync.flush();
    fs.rmSync(basePath, { recursive: true, force: true });
  });

  const folder = (id) => state.folders.find((row) => row.id === id);
  const note = (id) => state.notes.find((row) => row.id === id);
  const at = (...segments) => path.join(basePath, "Private notes", ...segments);
  // Applies a change to the database, as an IPC handler would, then lets the
  // mirror catch up.
  const change = async (apply) => {
    apply();
    sync.containersChanged();
    await sync.flush();
  };
  const writeUserFile = (relPath, content = "the user's own") => {
    const filePath = path.join(basePath, ...relPath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };
  const read = (relPath) => fs.readFileSync(path.join(basePath, ...relPath.split("/")), "utf8");
  const tree = () =>
    fs
      .readdirSync(basePath, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(basePath, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")
      )
      .sort();
  const notePathOf = (id) =>
    path.relative(basePath, markdownMirror.getNotePath(id)).split(path.sep).join("/");
  const frontmatterFolder = (id) =>
    JSON.parse(fs.readFileSync(markdownMirror.getNotePath(id), "utf8").match(/^folder: (.*)$/m)[1]);
  const noteRows = (id) =>
    [...entries.values()].filter((entry) => entry.ownerId === id && entry.kind !== "dir");
  return {
    sync,
    state,
    basePath,
    folder,
    note,
    at,
    change,
    writeUserFile,
    read,
    tree,
    notePathOf,
    frontmatterFolder,
    noteRows,
  };
}

const clientTree = {
  folders: [
    { id: 10, name: "Client A", space_id: PRIVATE },
    { id: 11, name: "Q1", space_id: PRIVATE, parent_folder_id: 10 },
  ],
  notes: [
    { id: 100, title: "Brief", space_id: PRIVATE, folder_id: 10 },
    { id: 101, title: "Plan", space_id: PRIVATE, folder_id: 11 },
  ],
};

test("a subfolder's notes sit in its directory inside its parent's", async (t) => {
  const fx = await createFixture(t, clientTree);

  assert.equal(fx.notePathOf(100), "Private notes/Client A/100-brief.md");
  assert.equal(fx.notePathOf(101), "Private notes/Client A/Q1/101-plan.md");
  assert.equal(fx.frontmatterFolder(100), "Client A");
  assert.equal(fx.frontmatterFolder(101), "Client A/Q1");
});

test("renaming a parent carries its subfolder, both levels' notes and the user's files", async (t) => {
  const fx = await createFixture(t, clientTree);
  fx.writeUserFile("Private notes/Client A/contract.pdf");
  fx.writeUserFile("Private notes/Client A/Q1/photo.png");
  const childInode = fs.statSync(fx.at("Client A", "Q1", "101-plan.md")).ino;

  await fx.change(() => (fx.folder(10).name = "Client B"));

  assert.deepEqual(fx.tree(), [
    "Private notes/Client B/100-brief.md",
    "Private notes/Client B/Q1/101-plan.md",
    "Private notes/Client B/Q1/photo.png",
    "Private notes/Client B/contract.pdf",
  ]);
  assert.equal(fs.statSync(fx.at("Client B", "Q1", "101-plan.md")).ino, childInode);
  assert.equal(fx.frontmatterFolder(101), "Client B/Q1");
  assert.equal(fx.noteRows(101).length, 1);
});

test("nesting and un-nesting a folder moves its directory with its attachments", async (t) => {
  const fx = await createFixture(t, {
    folders: [
      { id: 10, name: "Client A", space_id: PRIVATE },
      { id: 12, name: "Archive", space_id: PRIVATE },
    ],
    notes: [{ id: 102, title: "Old", space_id: PRIVATE, folder_id: 12 }],
  });
  fx.writeUserFile("Private notes/Archive/assets/figure.png", "image");

  await fx.change(() => (fx.folder(12).parent_folder_id = 10));
  assert.deepEqual(fx.tree(), [
    "Private notes/Client A/Archive/102-old.md",
    "Private notes/Client A/Archive/assets/figure.png",
  ]);
  assert.equal(fx.frontmatterFolder(102), "Client A/Archive");

  await fx.change(() => (fx.folder(12).parent_folder_id = null));
  assert.deepEqual(fx.tree(), [
    "Private notes/Archive/102-old.md",
    "Private notes/Archive/assets/figure.png",
  ]);
  assert.equal(fs.existsSync(fx.at("Client A")), true, "the parent's own directory stays");
  assert.equal(fx.read("Private notes/Archive/assets/figure.png"), "image");
});

for (const unlink of ["un-nested", "left pointing at the deleted parent"]) {
  test(`deleting a parent takes a live subfolder to the top level (${unlink})`, async (t) => {
    const fx = await createFixture(t, clientTree);
    fx.writeUserFile("Private notes/Client A/contract.pdf");
    fx.writeUserFile("Private notes/Client A/Q1/photo.png");

    fx.note(100).deleted_at = "now";
    fx.sync.deleteNote(100);
    await fx.change(() => {
      fx.state.folders = fx.state.folders.filter((row) => row.id !== 10);
      if (unlink === "un-nested") fx.folder(11).parent_folder_id = null;
    });

    assert.deepEqual(fx.tree(), [
      "Private notes/Client A/contract.pdf",
      "Private notes/Q1/101-plan.md",
      "Private notes/Q1/photo.png",
    ]);
    assert.equal(fx.frontmatterFolder(101), "Q1");
  });
}

test("moving a parent to another space carries its subfolder", async (t) => {
  const fx = await createFixture(t, {
    folders: [
      { id: 10, name: "Client A", space_id: TEAM },
      { id: 11, name: "Q1", space_id: TEAM, parent_folder_id: 10 },
    ],
    notes: [{ id: 101, title: "Plan", space_id: TEAM, folder_id: 11 }],
  });
  const team = "Workspaces/Other spaces/Teamspaces/Growth";
  fx.writeUserFile(`${team}/Client A/Q1/photo.png`);

  await fx.change(() => {
    fx.folder(10).space_id = PRIVATE;
    fx.folder(11).space_id = PRIVATE;
    fx.note(101).space_id = PRIVATE;
  });

  assert.deepEqual(fx.tree(), [
    "Private notes/Client A/Q1/101-plan.md",
    "Private notes/Client A/Q1/photo.png",
  ]);
});

test("binding the Private section to a workspace carries its nested folders", async (t) => {
  const fx = await createFixture(t, clientTree);
  fx.writeUserFile("Private notes/Client A/contract.pdf");
  fx.writeUserFile("Private notes/Client A/Q1/photo.png");

  await fx.change(() => (fx.state.spaces[0].workspace_id = "w-acme-1111"));

  const section = "Workspaces/Workspace w-acme-1/Private";
  assert.deepEqual(fx.tree(), [
    `${section}/Client A/100-brief.md`,
    `${section}/Client A/Q1/101-plan.md`,
    `${section}/Client A/Q1/photo.png`,
    `${section}/Client A/contract.pdf`,
  ]);
});

test("a subfolder moved alone to another space leaves its parent and goes at the top level", async (t) => {
  const fx = await createFixture(t, clientTree);
  fx.writeUserFile("Private notes/Client A/Q1/photo.png");

  // The pulled space move as the database applies it: the parent stays behind.
  await fx.change(() => {
    fx.folder(11).space_id = TEAM;
    fx.note(101).space_id = TEAM;
  });

  assert.deepEqual(fx.tree(), [
    "Private notes/Client A/100-brief.md",
    "Workspaces/Other spaces/Teamspaces/Growth/Q1/101-plan.md",
    "Workspaces/Other spaces/Teamspaces/Growth/Q1/photo.png",
  ]);
});

test("a parent nested elsewhere as its subfolder leaves, in one change, carries the files of both", async (t) => {
  const fx = await createFixture(t, {
    folders: [
      { id: 9, name: "R", space_id: PRIVATE },
      { id: 10, name: "P", space_id: PRIVATE },
      { id: 11, name: "C", space_id: PRIVATE, parent_folder_id: 10 },
    ],
    notes: [
      { id: 100, title: "Brief", space_id: PRIVATE, folder_id: 10 },
      { id: 101, title: "Plan", space_id: PRIVATE, folder_id: 11 },
    ],
  });
  fx.writeUserFile("Private notes/P/contract.pdf");
  fx.writeUserFile("Private notes/P/C/photo.png");

  await fx.change(() => {
    fx.folder(10).parent_folder_id = 9;
    fx.folder(11).parent_folder_id = null;
  });

  assert.deepEqual(fx.tree(), [
    "Private notes/C/101-plan.md",
    "Private notes/C/photo.png",
    "Private notes/R/P/100-brief.md",
    "Private notes/R/P/contract.pdf",
  ]);
});

test("another account's same-named parent and subfolder keep their files when one account renames", async (t) => {
  const fx = await createFixture(t, {
    accountId: "a2",
    folders: [
      { id: 10, name: "Projects", space_id: PRIVATE, account_id: "a1" },
      { id: 11, name: "Q1", space_id: PRIVATE, account_id: "a1", parent_folder_id: 10 },
      { id: 20, name: "Projects", space_id: PRIVATE, account_id: "a2" },
      { id: 21, name: "Q1", space_id: PRIVATE, account_id: "a2", parent_folder_id: 20 },
      { id: 22, name: "q1", space_id: PRIVATE, account_id: "a2", parent_folder_id: 20 },
    ],
    notes: [
      { id: 201, title: "Theirs", space_id: PRIVATE, folder_id: 21, account_id: "a2" },
      { id: 202, title: "Cased", space_id: PRIVATE, folder_id: 22, account_id: "a2" },
      { id: 101, title: "Mine", space_id: PRIVATE, folder_id: 11, account_id: "a1" },
    ],
  });
  fx.state.accountId = "a1";
  fx.sync.accountChanged();
  await fx.sync.flush();
  assert.equal(fx.notePathOf(101), "Private notes/Projects/Q1/101-mine.md");
  assert.equal(fx.notePathOf(201), "Private notes/Projects/Q1/201-theirs.md");
  assert.equal(fx.notePathOf(202), "Private notes/Projects/q1 (22)/202-cased.md");
  fx.writeUserFile("Private notes/Projects/Q1/shared.png");

  await fx.change(() => (fx.folder(10).name = "Clients"));

  assert.deepEqual(fx.tree(), [
    "Private notes/Clients/Q1/101-mine.md",
    "Private notes/Projects/Q1/201-theirs.md",
    "Private notes/Projects/Q1/shared.png",
    "Private notes/Projects/q1 (22)/202-cased.md",
  ]);
});

test("a folder named like a note file never collides with its parent's notes", async (t) => {
  const fx = await createFixture(t, {
    folders: [
      { id: 10, name: "Client A", space_id: PRIVATE },
      { id: 11, name: "100-brief.md", space_id: PRIVATE, parent_folder_id: 10 },
    ],
    notes: [
      { id: 100, title: "Brief", space_id: PRIVATE, folder_id: 10 },
      { id: 101, title: "Plan", space_id: PRIVATE, folder_id: 11 },
    ],
  });

  const [noteFile, childDir] = [fx.notePathOf(100), path.dirname(fx.notePathOf(101))];
  assert.equal(noteFile, "Private notes/Client A/100-brief.md");
  assert.match(childDir, /^Private notes\/Client A\/100-brief\.md \([0-9a-f]{8}\)$/);
  assert.ok(fx.read(noteFile).endsWith("Brief body"));
  assert.ok(fx.read(fx.notePathOf(101)).endsWith("Plan body"));
});

test("folders in a loop of parents, or whose parent is gone, still keep their notes' files", async (t) => {
  const fx = await createFixture(t, {
    folders: [
      { id: 10, name: "A", space_id: PRIVATE, parent_folder_id: 11 },
      { id: 11, name: "B", space_id: PRIVATE, parent_folder_id: 10 },
      { id: 12, name: "Orphan", space_id: PRIVATE, parent_folder_id: 999 },
    ],
    notes: [
      { id: 100, title: "In A", space_id: PRIVATE, folder_id: 10 },
      { id: 101, title: "In B", space_id: PRIVATE, folder_id: 11 },
      { id: 102, title: "Lost", space_id: PRIVATE, folder_id: 12 },
    ],
  });

  assert.deepEqual(fx.tree(), [
    "Private notes/A/100-in-a.md",
    "Private notes/B/101-in-b.md",
    "Private notes/Orphan/102-lost.md",
  ]);

  // Breaking the loop nests B in A, with its files.
  fx.writeUserFile("Private notes/B/photo.png");
  await fx.change(() => (fx.folder(10).parent_folder_id = null));
  assert.deepEqual(fx.tree(), [
    "Private notes/A/100-in-a.md",
    "Private notes/A/B/101-in-b.md",
    "Private notes/A/B/photo.png",
    "Private notes/Orphan/102-lost.md",
  ]);
});

test("a parent's case-only rename keeps its subfolder's files and ownership", async (t) => {
  const fx = await createFixture(t, clientTree);
  fx.writeUserFile("Private notes/Client A/Q1/photo.png");

  await fx.change(() => (fx.folder(10).name = "client a"));
  await fx.change(() => (fx.folder(11).name = "Q2"));

  assert.deepEqual(fx.tree(), [
    "Private notes/client a/100-brief.md",
    "Private notes/client a/Q2/101-plan.md",
    "Private notes/client a/Q2/photo.png",
  ]);
  assert.equal(fx.frontmatterFolder(101), "client a/Q2");
  assert.equal(fx.noteRows(101).length, 1);
});

// The old layout kept each folder in a top-level directory and predates
// subfolders, so only a top-level folder's empty old directory is tidied away.
test("an empty directory of the user's named like a subfolder stays", async (t) => {
  const fx = await createFixture(t, clientTree);
  fx.writeUserFile("Q1/.DS_Store", "");
  fx.writeUserFile("Client A/.DS_Store", "");

  fx.sync.disable();
  await fx.sync.enable(fx.basePath);
  await fx.sync.flush();

  assert.equal(fs.existsSync(path.join(fx.basePath, "Q1", ".DS_Store")), true);
  assert.equal(fs.existsSync(path.join(fx.basePath, "Client A")), false);
});

function ignoresCase(directory) {
  const probe = path.join(directory, `case-probe-${process.pid}`);
  fs.writeFileSync(probe, "");
  try {
    return fs.existsSync(probe.toUpperCase().replace(directory.toUpperCase(), directory));
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

test("nesting a folder under one named the same but for case keeps each one's attachments", async (t) => {
  if (!ignoresCase(os.tmpdir())) {
    t.skip("this disk tells case apart, so the two directories never meet");
    return;
  }
  const fx = await createFixture(t, {
    folders: [
      { id: 10, name: "projects", space_id: PRIVATE },
      { id: 11, name: "Projects", space_id: PRIVATE },
    ],
    notes: [
      { id: 100, title: "Low", space_id: PRIVATE, folder_id: 10 },
      { id: 101, title: "High", space_id: PRIVATE, folder_id: 11 },
    ],
  });
  const upperDir = path.dirname(fx.notePathOf(101));
  fx.writeUserFile("Private notes/projects/low.png", "low");
  fx.writeUserFile(`${upperDir}/high.png`, "high");

  await fx.change(() => (fx.folder(10).parent_folder_id = 11));

  assert.deepEqual(fx.tree(), [
    "Private notes/Projects/101-high.md",
    "Private notes/Projects/high.png",
    "Private notes/Projects/projects/100-low.md",
    "Private notes/Projects/projects/low.png",
  ]);
  assert.equal(fx.read("Private notes/Projects/projects/low.png"), "low");
  assert.equal(fx.read("Private notes/Projects/high.png"), "high");
  assert.equal(fx.noteRows(100).length, 1);
  assert.equal(fx.noteRows(101).length, 1);
});

// The parent's own files stay where they were, its subfolder goes alone, and
// what was already in the way is left as it is.
test("a parent whose new directory is taken loses nothing", async (t) => {
  const fx = await createFixture(t, clientTree);
  fx.writeUserFile("Private notes/Client A/contract.pdf");
  fx.writeUserFile("Private notes/Client A/Q1/photo.png");
  fx.writeUserFile("Private notes/Client B/readme.txt", "already here");

  await fx.change(() => (fx.folder(10).name = "Client B"));

  assert.deepEqual(fx.tree(), [
    "Private notes/Client A/contract.pdf",
    "Private notes/Client B/100-brief.md",
    "Private notes/Client B/Q1/101-plan.md",
    "Private notes/Client B/Q1/photo.png",
    "Private notes/Client B/readme.txt",
  ]);
  assert.equal(fx.read("Private notes/Client B/readme.txt"), "already here");
  assert.equal(fx.noteRows(100).length, 1);
  assert.equal(fx.noteRows(101).length, 1);
});

test("a parent's move the disk refuses loses nothing, and its subfolder goes alone", async (t) => {
  const fx = await createFixture(t, clientTree);
  fx.writeUserFile("Private notes/Client A/contract.pdf");
  fx.writeUserFile("Private notes/Client A/Q1/photo.png");
  const rename = fs.renameSync;
  const source = fs.realpathSync.native(fx.at("Client A"));
  t.mock.method(fs, "renameSync", (from, to) => {
    if (from === source) throw Object.assign(new Error("read-only"), { code: "EACCES" });
    return rename(from, to);
  });

  await fx.change(() => (fx.folder(10).name = "Client B"));

  assert.deepEqual(fx.tree(), [
    "Private notes/Client A/contract.pdf",
    "Private notes/Client B/100-brief.md",
    "Private notes/Client B/Q1/101-plan.md",
    "Private notes/Client B/Q1/photo.png",
  ]);
  assert.ok(fx.read(fx.notePathOf(101)).endsWith("Plan body"));
  assert.equal(fx.noteRows(100).length, 1);
  assert.equal(fx.noteRows(101).length, 1);
});
