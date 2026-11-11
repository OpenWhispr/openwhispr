// Drives the real IPC handlers and the real mirror against a temp directory.
// The database is an in-memory stand-in for the handful of queries the mirror
// makes; its real queries are covered in spacesDatabase.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const openedPaths = [];

const electronStub = {
  app: {
    getPath: () => os.tmpdir(),
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }

    static fromWebContents() {
      return null;
    }
  },
  shell: {
    openPath: async (target) => {
      openedPaths.push(target);
      return "";
    },
    showItemInFolder: () => {},
  },
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (request === "./debugLogger" || request === "../helpers/debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function makeDatabase() {
  const state = {
    spaces: [
      { id: 1, kind: "private", name: "Personal", workspace_id: null, deleted_at: null },
      { id: 2, kind: "team", name: "Engineering", workspace_id: "w-acme-1111", deleted_at: null },
      { id: 3, kind: "team", name: "Engineering", workspace_id: "w-beta-2222", deleted_at: null },
    ],
    folders: [
      { id: 10, name: "General", space_id: 2, account_id: null, deleted_at: null },
      { id: 11, name: "General", space_id: 3, account_id: null, deleted_at: null },
      { id: 12, name: "General", space_id: 1, account_id: "a1", deleted_at: null },
    ],
    notes: [
      { id: 100, title: "Acme retro", content: "acme body", folder_id: 10, space_id: 2 },
      { id: 101, title: "Beta retro", content: "beta body", folder_id: 11, space_id: 3 },
      { id: 102, title: "Mine", content: "my body", folder_id: 12, space_id: 1 },
      { id: 103, title: "Root note", content: "root body", folder_id: null, space_id: 2 },
    ].map((note) => ({ deleted_at: null, account_id: null, ...note })),
    workspaceNames: { "w-acme-1111": "Acme", "w-beta-2222": "Beta" },
    outOfScopeNoteIds: new Set(),
    mirrorFiles: new Map(),
  };

  const inScope = (note) => !state.outOfScopeNoteIds.has(note.id);
  const folder = (id) => state.folders.find((row) => row.id === id);
  const space = (id) => state.spaces.find((row) => row.id === id);

  return {
    state,
    mergedNotes: [],
    getMirrorContainers: () => ({
      spaces: state.spaces.filter((row) => !row.deleted_at),
      folders: state.folders.filter((row) => !row.deleted_at),
      workspaceNames: { ...state.workspaceNames },
    }),
    setWorkspaceNames: (rows) => {
      let changed = 0;
      for (const { id, name } of rows) {
        if (state.workspaceNames[id] !== name) changed++;
        state.workspaceNames[id] = name;
      }
      return changed;
    },
    getMirrorFiles: (basePath) =>
      [...state.mirrorFiles.values()].filter((entry) => entry.basePath === basePath),
    recordMirrorFile: (basePath, entry) =>
      state.mirrorFiles.set(`${basePath}\0${entry.relPath}`, { ...entry, basePath }),
    forgetMirrorFile: (basePath, relPath) => state.mirrorFiles.delete(`${basePath}\0${relPath}`),
    getExistingNoteIds: (ids) =>
      state.notes.filter((note) => ids.includes(note.id)).map((note) => note.id),
    getNotesForMirror: (ids) =>
      state.notes.filter((note) => ids.includes(note.id) && inScope(note)),
    getNote: (id) => state.notes.find((note) => note.id === id && inScope(note)) ?? null,
    getNotes: () => state.notes.filter((note) => !note.deleted_at && inScope(note)),
    getMirrorNoteSummaries: () => {
      state.summaryReads = (state.summaryReads ?? 0) + 1;
      const summaries = state.notes
        .filter((note) => !note.deleted_at && inScope(note))
        .map(({ id, title, folder_id, space_id, transcript }) => ({
          id,
          title,
          folder_id,
          space_id,
          has_transcript: transcript && transcript !== "[]" ? 1 : 0,
        }));
      state.afterSummaries?.();
      return summaries;
    },
    getFolders: () => state.folders.filter((row) => !row.deleted_at),
    renameFolder: (id, name) => {
      folder(id).name = name;
      return { success: true, folder: folder(id) };
    },
    deleteFolder: (id) => {
      folder(id).deleted_at = "now";
      const deleted = state.notes.filter((note) => note.folder_id === id && !note.deleted_at);
      for (const note of deleted) note.deleted_at = "now";
      return { success: true, id, noteIds: deleted.map((note) => note.id), relocatedNotes: [] };
    },
    moveFolderToSpace: (id, spaceId) => {
      folder(id).space_id = spaceId;
      for (const note of state.notes) if (note.folder_id === id) note.space_id = spaceId;
      return { success: true, folder: folder(id) };
    },
    updateSpace: (id, { name }) => {
      space(id).name = name;
      return { success: true, space: space(id) };
    },
    upsertFolderFromCloud: (cloudFolder) => {
      Object.assign(folder(cloudFolder.id), cloudFolder);
      return folder(cloudFolder.id);
    },
    upsertSpaceFromCloud: (cloudSpace) => {
      Object.assign(space(cloudSpace.id), cloudSpace);
      return space(cloudSpace.id);
    },
    upsertNoteFromCloud: (cloudNote) => {
      const existing = state.notes.find((note) => note.id === cloudNote.id);
      if (existing) Object.assign(existing, cloudNote);
      else state.notes.push({ deleted_at: null, account_id: null, ...cloudNote });
      return state.notes.find((note) => note.id === cloudNote.id);
    },
  };
}

let target;
let basePath;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = Object.create(Ctor.prototype);
  target._buildSpeakerMappings = () => ({});
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
      set: (value, property, next) => {
        value[property] = next;
        return true;
      },
    })
  );
});

test.after(() => {
  Module._load = originalLoad;
});

test.beforeEach(() => {
  basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-files-ipc-"));
  target.databaseManager = makeDatabase();
  target._noteFilesSync = undefined;
  openedPaths.length = 0;
});

test.afterEach(async () => {
  await settle();
  await invoke("note-files-set-enabled", false);
  fs.rmSync(basePath, { recursive: true, force: true });
});

const invoke = (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args);

// Everything the handlers schedule: setImmediate work, then the batches.
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await target._noteFilesSync?.flush();
  await new Promise((resolve) => setImmediate(resolve));
}

async function enableMirror(options) {
  const result = await invoke("note-files-set-enabled", true, basePath, options);
  assert.equal(result.success, true);
  await settle();
}

function allFiles(dir = basePath) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? allFiles(entryPath) : [entryPath];
  });
}

function fileOf(noteId) {
  const prefix = `${noteId}-`;
  const matches = allFiles().filter((file) => path.basename(file).startsWith(prefix));
  assert.equal(matches.length, 1, `note ${noteId}: expected one file, found ${matches}`);
  return matches[0];
}

const relativeDir = (file) => path.relative(basePath, path.dirname(file)).split(path.sep).join("/");

function frontmatterOf(file) {
  const block = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/)[1];
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 2)];
    })
  );
}

function legacyFile(folderName, name, content) {
  const dir = path.join(basePath, folderName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

const legacyNote = (id, title, folder, body) =>
  `---\nid: ${id}\ntitle: ${title}\ntype: personal\nfolder: ${folder}\ncreated: x\nupdated: y\n---\n\n${body}`;

test("same-named folders in different workspaces get separate directories", async () => {
  await enableMirror();

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/General");
  assert.equal(relativeDir(fileOf(101)), "Workspaces/Beta/Teamspaces/Engineering/General");
  assert.equal(relativeDir(fileOf(102)), "Private notes/General");
});

test("renaming a folder leaves another workspace's same-named folder where it is", async () => {
  await enableMirror();
  const betaFile = fileOf(101);

  await invoke("db-rename-folder", 10, "Archive");
  await settle();

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/Archive");
  assert.equal(fileOf(101), betaFile);
  assert.equal(
    fs.existsSync(path.join(basePath, "Workspaces/Acme/Teamspaces/Engineering/General")),
    false,
    "the emptied directory goes away"
  );
});

test("renaming onto a name that already holds files still moves the folder's files", async () => {
  const db = target.databaseManager;
  db.state.folders.push({ id: 13, name: "Docs", space_id: 3, account_id: null, deleted_at: null });
  db.state.notes.push({
    id: 104,
    title: "Existing doc",
    content: "doc body",
    folder_id: 13,
    space_id: 3,
    deleted_at: null,
    account_id: null,
  });
  await enableMirror();

  await invoke("db-rename-folder", 11, "Docs");
  await invoke("db-delete-folder", 13);
  await settle();

  assert.equal(relativeDir(fileOf(101)), "Workspaces/Beta/Teamspaces/Engineering/Docs");
  assert.equal(allFiles().filter((file) => path.basename(file).startsWith("104-")).length, 0);
});

test("a rename whose target directory is taken on disk merges beside what is there", async () => {
  await enableMirror();
  const userFile = path.join(
    basePath,
    "Workspaces/Beta/Teamspaces/Engineering/Archive/my-notes.txt"
  );
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, "mine");

  await invoke("db-rename-folder", 11, "Archive");
  await settle();

  assert.equal(relativeDir(fileOf(101)), "Workspaces/Beta/Teamspaces/Engineering/Archive");
  assert.equal(fs.readFileSync(userFile, "utf8"), "mine");
});

test("deleting a folder removes its notes' files while a same-named folder stays", async () => {
  await enableMirror();
  const betaFile = fileOf(101);
  const acmeFile = fileOf(100);

  await invoke("db-delete-folder", 10);
  await settle();

  assert.equal(fs.existsSync(acmeFile), false, "the deleted note's file must not be orphaned");
  assert.equal(fs.existsSync(betaFile), true);
  assert.equal(fileOf(103).includes("Engineering"), true, "the space root's note stays");
});

test("deleting a folder keeps a file the user put in its directory", async () => {
  await enableMirror();
  const userFile = path.join(path.dirname(fileOf(100)), "my-notes.txt");
  fs.writeFileSync(userFile, "mine");

  await invoke("db-delete-folder", 10);
  await settle();

  assert.equal(fs.readFileSync(userFile, "utf8"), "mine");
});

test("a rebuild removes the file of a deleted note and leaves ids it doesn't know", async () => {
  await enableMirror();
  const acmeFile = fileOf(100);
  target.databaseManager.state.notes.find((note) => note.id === 100).deleted_at = "now";
  const unknownFile = path.join(path.dirname(acmeFile), "999-from-before-a-reset.md");
  fs.writeFileSync(unknownFile, legacyNote(999, "Old", "General", "only copy"));

  await invoke("note-files-rebuild");
  await settle();

  assert.equal(fs.existsSync(acmeFile), false);
  assert.equal(fs.existsSync(unknownFile), true);
});

test("a team-space root note is not written into the Personal directory", async () => {
  await enableMirror();

  const file = fileOf(103);
  assert.equal(relativeDir(file), "Workspaces/Acme/Teamspaces/Engineering");
  assert.equal("folder" in frontmatterOf(file), false);
});

test("frontmatter names the note's workspace and space", async () => {
  await enableMirror();

  const team = frontmatterOf(fileOf(100));
  assert.equal(team.workspace, "Acme");
  assert.equal(team.space, "Engineering");
  assert.equal(team.folder, "General");

  const mine = frontmatterOf(fileOf(102));
  assert.equal("workspace" in mine, false);
  assert.equal(mine.space, "Private");
  assert.equal(mine.folder, "General");
});

test("workspaces with the same name don't share a directory", async () => {
  target.databaseManager.state.workspaceNames["w-beta-2222"] = "Acme";
  await enableMirror();

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/General");
  assert.equal(relativeDir(fileOf(101)), "Workspaces/Acme (w-beta)/Teamspaces/Engineering/General");
  assert.equal(frontmatterOf(fileOf(101)).workspace, "Acme");
});

test("files move when a workspace's name arrives or changes", async () => {
  delete target.databaseManager.state.workspaceNames["w-acme-1111"];
  await enableMirror();
  assert.equal(
    relativeDir(fileOf(100)),
    "Workspaces/Workspace w-acme-1/Teamspaces/Engineering/General"
  );

  await invoke("note-files-set-workspace-names", [{ id: "w-acme-1111", name: "Acme" }]);
  await settle();
  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/General");
  assert.equal(relativeDir(fileOf(103)), "Workspaces/Acme/Teamspaces/Engineering");
  assert.equal(frontmatterOf(fileOf(100)).workspace, "Acme");
  assert.equal(fs.existsSync(path.join(basePath, "Workspaces/Workspace w-acme-1")), false);

  await invoke("note-files-set-workspace-names", [{ id: "w-acme-1111", name: "Acme Inc" }]);
  await settle();
  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme Inc/Teamspaces/Engineering/General");
  assert.equal(fs.existsSync(path.join(basePath, "Workspaces/Acme")), false);
});

test("renaming a space moves its notes, root notes included", async () => {
  await enableMirror();

  await invoke("db-update-space", 2, { name: "Platform" });
  await settle();

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Platform/General");
  assert.equal(relativeDir(fileOf(103)), "Workspaces/Acme/Teamspaces/Platform");
  assert.equal(frontmatterOf(fileOf(100)).space, "Platform");
});

test("moving a folder to another space moves its notes", async () => {
  await enableMirror();

  await invoke("db-move-folder-to-space", 10, 1);
  await settle();

  assert.equal(relativeDir(fileOf(100)), "Private notes/General");
  assert.equal("workspace" in frontmatterOf(fileOf(100)), false);
});

test("a window reloading while a rename waits doesn't lose the move", async () => {
  await enableMirror();

  await invoke("db-rename-folder", 10, "Archive");
  await invoke("note-files-set-enabled", true, basePath, { skipRebuild: true });
  await settle();

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/Archive");
});

test("a folder renamed on another device moves its notes when the pull arrives", async () => {
  await enableMirror();

  await invoke("db-upsert-folder-from-cloud", { id: 10, name: "Pulled" }, 2);
  await settle();

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/Pulled");
});

test("a space renamed on another device moves its notes when the pull arrives", async () => {
  await enableMirror();

  await invoke("db-upsert-space-from-cloud", { id: 2, name: "Pulled space" });
  await settle();

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Pulled space/General");
});

test("a note pulled from the cloud reaches its file", async () => {
  await enableMirror();

  await invoke(
    "db-upsert-note-from-cloud",
    { id: 100, title: "Acme retro", content: "edited by a teammate", folder_id: 10, space_id: 2 },
    10,
    2
  );
  await invoke(
    "db-upsert-note-from-cloud",
    { id: 105, title: "New from a teammate", content: "new body", folder_id: 10, space_id: 2 },
    10,
    2
  );
  await settle();

  assert.match(fs.readFileSync(fileOf(100), "utf8"), /edited by a teammate/);
  assert.equal(relativeDir(fileOf(105)), "Workspaces/Acme/Teamspaces/Engineering/General");
});

test("a pulled delete removes the file", async () => {
  await enableMirror();
  const acmeFile = fileOf(100);

  await invoke("db-upsert-note-from-cloud", { id: 100, deleted_at: "now" }, 10, 2);
  await settle();

  assert.equal(fs.existsSync(acmeFile), false);
});

test("folders open from their id, not a name another workspace can share", async () => {
  await enableMirror();

  const result = await invoke("show-folder-in-explorer", 11);

  assert.equal(result.success, true);
  assert.deepEqual(
    openedPaths.map((opened) => path.relative(basePath, opened).split(path.sep).join("/")),
    ["Workspaces/Beta/Teamspaces/Engineering/General"]
  );
});

test("a new folder gets its directory in its own space", async () => {
  await enableMirror();
  const db = target.databaseManager;
  db.createFolder = (name, spaceId) => {
    const folder = { id: 14, name, space_id: spaceId, account_id: null, deleted_at: null };
    db.state.folders.push(folder);
    return { success: true, folder };
  };

  await invoke("db-create-folder", "Fresh", 3);
  await settle();

  assert.equal(
    fs.existsSync(path.join(basePath, "Workspaces/Beta/Teamspaces/Engineering/Fresh")),
    true
  );
  assert.equal(fs.existsSync(path.join(basePath, "Fresh")), false);
});

test("mirror writes stop while the feature is off", async () => {
  await invoke("db-rename-folder", 10, "Archive");
  await invoke("db-upsert-note-from-cloud", { id: 100, content: "x" }, 10, 2);
  await settle();

  assert.deepEqual(allFiles(), []);
});

test("existing files move into the new layout when the mirror starts", async () => {
  const unchanged = legacyFile(
    "General",
    "100-acme-retro.md",
    legacyNote(100, "Acme retro", "General", "acme body")
  );
  const crlf = legacyFile(
    "General",
    "101-beta-retro.md",
    `\uFEFF${legacyNote(101, "Beta retro", "General", "beta body\n")}`.replace(/\n/g, "\r\n")
  );

  await enableMirror({ skipRebuild: true });

  assert.equal(fs.existsSync(unchanged), false);
  assert.equal(fs.existsSync(crlf), false);
  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/General");
  assert.equal(relativeDir(fileOf(101)), "Workspaces/Beta/Teamspaces/Engineering/General");
  assert.match(fs.readFileSync(fileOf(100), "utf8"), /acme body/);
  assert.equal(fs.existsSync(path.join(basePath, "General")), false, "the emptied folder goes");
});

test("a file edited outside the app is kept beside its old location", async () => {
  const edited = legacyNote(100, "Acme retro", "General", "my own edit");
  legacyFile("General", "100-acme-retro.md", edited);

  await enableMirror({ skipRebuild: true });

  const kept = path.join(basePath, "General", "edited-100-acme-retro.md");
  assert.equal(fs.readFileSync(kept, "utf8"), edited);
  assert.match(fs.readFileSync(fileOf(100), "utf8"), /acme body/);
  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/General");

  await invoke("note-files-rebuild");
  await settle();
  assert.equal(fs.readFileSync(kept, "utf8"), edited, "later passes leave it alone");
});

test("frontmatter a person added counts as an edit", async () => {
  const edited = legacyNote(100, "Acme retro", "General", "acme body").replace(
    "\nupdated:",
    "\ntags: [work]\nupdated:"
  );
  legacyFile("General", "100-acme-retro.md", edited);

  await enableMirror({ skipRebuild: true });

  assert.equal(
    fs.readFileSync(path.join(basePath, "General", "edited-100-acme-retro.md"), "utf8"),
    edited
  );
});

test("the move leaves other accounts' notes, unknown ids and the user's files alone", async () => {
  target.databaseManager.state.outOfScopeNoteIds.add(102);
  const otherAccount = legacyFile(
    "General",
    "102-mine.md",
    legacyNote(102, "Mine", "General", "my body")
  );
  const unknown = legacyFile(
    "General",
    "999-old.md",
    legacyNote(999, "Old", "General", "only copy")
  );
  const userFile = legacyFile("General", "shopping.md", "---\nnot: ours\n---\n");
  const userFolderFile = legacyFile("Recipes", "soup.txt", "soup");
  const dotFile = legacyFile(".obsidian", "100-acme-retro.md", legacyNote(100, "x", "x", "x"));

  await enableMirror({ skipRebuild: true });

  for (const kept of [otherAccount, unknown, userFile, userFolderFile, dotFile]) {
    assert.equal(fs.existsSync(kept), true, `${kept} must stay`);
  }
});

test("the move drops a deleted note's old file but keeps it when edited", async () => {
  const db = target.databaseManager;
  db.state.notes.find((note) => note.id === 100).deleted_at = "now";
  db.state.notes.find((note) => note.id === 101).deleted_at = "now";
  const plain = legacyFile(
    "General",
    "100-acme-retro.md",
    legacyNote(100, "Acme retro", "General", "acme body")
  );
  legacyFile(
    "General",
    "101-beta-retro.md",
    legacyNote(101, "Beta retro", "General", "edited before deleting")
  );

  await enableMirror({ skipRebuild: true });

  assert.equal(fs.existsSync(plain), false);
  assert.equal(fs.existsSync(path.join(basePath, "General", "edited-101-beta-retro.md")), true);
});

test("the emptied old folder goes even with a Finder or Explorer leftover in it", async () => {
  legacyFile("General", "100-acme-retro.md", legacyNote(100, "Acme retro", "General", "acme body"));
  legacyFile("General", ".DS_Store", "x");

  await enableMirror({ skipRebuild: true });

  assert.equal(fs.existsSync(path.join(basePath, "General")), false);
});

test("the move runs again safely and picks up an account's notes after a switch", async () => {
  const db = target.databaseManager;
  db.state.outOfScopeNoteIds.add(102);
  const otherAccount = legacyFile(
    "General",
    "102-mine.md",
    legacyNote(102, "Mine", "General", "my body")
  );
  await enableMirror({ skipRebuild: true });
  assert.equal(fs.existsSync(otherAccount), true);

  db.state.outOfScopeNoteIds.delete(102);
  target.noteFiles.accountChanged();
  await settle();

  assert.equal(fs.existsSync(otherAccount), false);
  assert.equal(relativeDir(fileOf(102)), "Private notes/General");
});

test("a Private section bound to its workspace moves there, and back when relocated", async () => {
  await enableMirror();
  const db = target.databaseManager;
  const privateSpace = db.state.spaces.find((space) => space.id === 1);

  privateSpace.workspace_id = "w-acme-1111";
  target.noteFiles.containersChanged();
  await settle();
  assert.equal(relativeDir(fileOf(102)), "Workspaces/Acme/Private/General");
  assert.equal(frontmatterOf(fileOf(102)).workspace, "Acme");
  assert.equal(fs.existsSync(path.join(basePath, "Private notes")), false);

  // A lost workspace's Private moves into another private space by plain SQL.
  db.state.spaces.push({
    id: 4,
    kind: "private",
    name: "Personal",
    workspace_id: "w-beta-2222",
    deleted_at: null,
  });
  db.state.folders.find((folder) => folder.id === 12).space_id = 4;
  db.state.notes.find((note) => note.id === 102).space_id = 4;
  privateSpace.deleted_at = "now";
  target.noteFiles.containersChanged();
  await settle();
  assert.equal(relativeDir(fileOf(102)), "Workspaces/Beta/Private/General");
  assert.equal(fs.existsSync(path.join(basePath, "Workspaces/Acme/Private")), false);
});

test("a rename made while the mirror was off is picked up when it starts", async () => {
  await enableMirror();
  await invoke("note-files-set-enabled", false);
  target.databaseManager.state.folders.find((folder) => folder.id === 10).name = "Renamed";

  await enableMirror({ skipRebuild: true });

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/Renamed");
});

test("an edit made outside the app survives its folder being renamed", async () => {
  await enableMirror();
  const original = fileOf(100);
  fs.appendFileSync(original, "\nmine");

  await invoke("db-rename-folder", 10, "Archive");
  await settle();

  assert.match(
    fs.readFileSync(path.join(path.dirname(original), `edited-${path.basename(original)}`), "utf8"),
    /mine$/
  );
  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering/Archive");
});

test("the mirror's files of a note gone from the database go; files it didn't write stay", async () => {
  await enableMirror();
  const db = target.databaseManager;
  const acmeFile = fileOf(100);
  const userCopy = path.join(path.dirname(acmeFile), "100-my-copy.md");
  fs.writeFileSync(userCopy, "---\nid: 100\n---\n\ncopy");
  db.state.notes = db.state.notes.filter((note) => note.id !== 100);

  await invoke("note-files-rebuild");
  await settle();

  assert.equal(fs.existsSync(acmeFile), false);
  assert.equal(fs.readFileSync(userCopy, "utf8"), "---\nid: 100\n---\n\ncopy");
});

test("after a database reset nothing already on disk is deleted", async () => {
  await enableMirror();
  const before = allFiles().map((file) => [file, fs.readFileSync(file, "utf8")]);
  target.databaseManager.state.mirrorFiles.clear();
  for (const note of target.databaseManager.state.notes) note.content = `new ${note.id}`;

  await invoke("note-files-rebuild");
  await settle();

  const contents = new Set(allFiles().map((file) => fs.readFileSync(file, "utf8")));
  for (const [, content] of before) assert.ok(contents.has(content), "every old file survives");
});

test("a sync pass that changes no space or folder doesn't reread every note", async () => {
  await enableMirror();
  const db = target.databaseManager;
  const reads = db.state.summaryReads;
  assert.ok(reads > 0, "starting the mirror reconciles once");

  await invoke("db-upsert-space-from-cloud", { id: 2, name: "Engineering" });
  await invoke("db-upsert-folder-from-cloud", { id: 10, name: "General" }, 2);
  await settle();

  assert.equal(db.state.summaryReads, reads);
});

test("notes moved in bulk without any container changing are still moved", async () => {
  await enableMirror();
  target.databaseManager.state.notes.find((note) => note.id === 100).folder_id = null;

  target.noteFiles.notesMoved();
  await settle();

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering");
});

test("a reconcile writes what the note says when it writes, not when it started", async () => {
  await enableMirror();
  const db = target.databaseManager;
  db.state.folders.find((folder) => folder.id === 10).name = "Moved";
  db.state.afterSummaries = () => {
    db.state.notes.find((note) => note.id === 100).content = "edited meanwhile";
    db.state.afterSummaries = null;
  };

  target.noteFiles.containersChanged();
  await settle();

  assert.match(fs.readFileSync(fileOf(100), "utf8"), /edited meanwhile$/);
});

test("deleting a folder rewrites another account's notes released to the space root", async () => {
  await enableMirror();
  const db = target.databaseManager;
  const released = db.state.notes.find((note) => note.id === 100);
  db.deleteFolder = (id) => {
    db.state.folders.find((folder) => folder.id === id).deleted_at = "now";
    released.folder_id = null;
    return { success: true, id, noteIds: [], relocatedNotes: [released] };
  };

  await invoke("db-delete-folder", 10);
  await settle();

  assert.equal(relativeDir(fileOf(100)), "Workspaces/Acme/Teamspaces/Engineering");
});

test("an unchanged old file of a copy merged at launch goes; an edited one stays", async () => {
  const db = target.databaseManager;
  const merged = (id, title) => ({ id, title, content: "dup body", note_type: "personal" });
  db.mergedNotes.push(merged(201, "Dup"), merged(202, "Dup two"));
  legacyFile("General", "201-dup.md", legacyNote(201, "Dup", "General", "dup body"));
  const edited = legacyFile(
    "General",
    "202-dup-two.md",
    legacyNote(202, "Dup two", "General", "my edit")
  );

  await enableMirror({ skipRebuild: true });

  assert.equal(fs.existsSync(path.join(basePath, "General", "201-dup.md")), false);
  assert.equal(fs.existsSync(edited), false);
  assert.equal(fs.existsSync(path.join(basePath, "General", "edited-202-dup-two.md")), true);
});

test("Show in folder opens an empty folder, creating its directory", async () => {
  const db = target.databaseManager;
  db.state.folders.push({ id: 15, name: "Empty", space_id: 3, account_id: null, deleted_at: null });
  await enableMirror();

  const result = await invoke("show-folder-in-explorer", 15);

  assert.equal(result.success, true);
  assert.equal(
    fs.existsSync(path.join(basePath, "Workspaces/Beta/Teamspaces/Engineering/Empty")),
    true
  );
});

test(
  "a rename that only changes case keeps the note's file",
  { skip: !caseInsensitive() && "needs a case-insensitive file system" },
  async () => {
    await enableMirror();

    await invoke("db-rename-folder", 10, "general");
    await settle();

    assert.match(fs.readFileSync(fileOf(100), "utf8"), /acme body/);
  }
);

function caseInsensitive() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "OpenWhisprCaseProbe-"));
  try {
    return fs.existsSync(probe.toLowerCase()) && fs.existsSync(probe.toUpperCase());
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
