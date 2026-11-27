const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// The real folder handler closures over a real DatabaseManager and the real
// note files mirror (noteFilesSync over markdownMirror). A subfolder's directory
// sits inside its parent's, and its notes and the user's files follow it through
// every change to its parent.
const { createDb } = require("./harness/db.js");
const { getUserDataDir, setUserDataDir } = require("./harness/electronStub.js");
const markdownMirror = require("../../src/helpers/markdownMirror");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const sent = [];
const tokenState = { token: "token", generation: 1 };

const electronStub = {
  app: {
    getPath: () => getUserDataDir(),
    getAppPath: () => process.cwd(),
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    isReady: () => false,
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
      return [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, data) => sent.push([channel, data]) },
        },
      ];
    }

    static fromWebContents() {
      return null;
    }
  },
  shell: {},
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
  if (parent?.filename === handlersModulePath && request === "./tokenStore") {
    return { get: () => null, getState: () => tokenState, subscribe: () => () => {} };
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

const current = { db: null };
let target = null;
// Handler setup opens its own databases under userData before any test sets one.
const setupUserData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-subfolder-ipc-"));

test.before(() => {
  setUserDataDir(setupUserData);
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = Object.create(Ctor.prototype);
  // Handler setup reads the database before any test has one.
  Object.defineProperty(target, "databaseManager", { get: () => current.db ?? anything() });
  target.notifyVectorChanges = () => {};
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
  fs.rmSync(setupUserData, { recursive: true, force: true });
});

const invoke = (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args);

// The handlers' deferred work, then everything the mirror has scheduled.
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await target._noteFilesSync?.flush();
  await new Promise((resolve) => setImmediate(resolve));
};

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  db.setActiveAccountId("test-account");
  current.db = db;
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-subfolder-mirror-"));
  target._noteFilesSync = undefined;
  t.after(async () => {
    await settle();
    await invoke("note-files-set-enabled", false);
    fs.rmSync(basePath, { recursive: true, force: true });
  });
  const enabled = await invoke("note-files-set-enabled", true, basePath, { skipRebuild: true });
  assert.equal(enabled.success, true);
  await settle();
  sent.length = 0;
  // The account's Private section before it is bound to a workspace.
  return { db, basePath, privateDir: path.join(basePath, "Private notes") };
}

const guard = () => ({ accountId: "test-account", authGeneration: tokenState.generation });
const createFolder = async (name, spaceId = null, parentFolderId = undefined) =>
  (await invoke("db-create-folder", name, spaceId, guard(), parentFolderId)).folder;
const setParent = (id, parentFolderId) =>
  invoke("db-set-folder-parent", id, parentFolderId, guard());

const writeUserFile = (...segments) => {
  fs.mkdirSync(path.dirname(path.join(...segments)), { recursive: true });
  fs.writeFileSync(path.join(...segments), "the user's own");
};
const transcript = JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Hello." }]);
const saveMirroredNote = (db, title, folderId) => {
  const note = db.saveNote(title, "Body", "personal", null, null, folderId, null, transcript).note;
  target.noteFiles.writeNote(note);
  return note;
};
const notePath = (note, ...dir) => path.join(...dir, `${note.id}-${note.title.toLowerCase()}.md`);
const addTeam = (db, name) => {
  const team = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, 1)"
    )
    .run(`team-${name}`, name);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team.lastInsertRowid, "test-account");
  return team.lastInsertRowid;
};
const teamDir = (basePath, name) =>
  path.join(basePath, "Workspaces", "Other spaces", "Teamspaces", name);
const filesUnder = (dirPath) =>
  fs.existsSync(dirPath) ? fs.readdirSync(dirPath, { recursive: true }).sort() : [];

test("creating, renaming and re-parenting a subfolder keeps its directory inside its parent's", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const parent = await createFolder("Client A");
  const child = await createFolder("Q1", null, parent.id);
  await settle();
  assert.equal(child.parent_folder_id, parent.id);
  assert.ok(fs.statSync(path.join(privateDir, "Client A", "Q1")).isDirectory());
  assert.ok(!fs.existsSync(path.join(privateDir, "Q1")));
  const note = saveMirroredNote(db, "Plan", child.id);
  await settle();
  writeUserFile(privateDir, "Client A", "Q1", "photo.png");

  await invoke("db-rename-folder", child.id, "Q2");
  await settle();
  assert.equal(markdownMirror.getNotePath(note.id), notePath(note, privateDir, "Client A", "Q2"));
  assert.ok(fs.existsSync(path.join(privateDir, "Client A", "Q2", "photo.png")));
  assert.ok(!fs.existsSync(path.join(privateDir, "Client A", "Q1")));

  const unnested = await setParent(child.id, null);
  await settle();
  assert.equal(unnested.folder.parent_folder_id, null);
  assert.equal(markdownMirror.getNotePath(note.id), notePath(note, privateDir, "Q2"));
  assert.ok(fs.existsSync(path.join(privateDir, "Q2", "photo.png")));
  assert.deepEqual(filesUnder(path.join(privateDir, "Client A")), []);
  assert.deepEqual(sent.at(-1), ["folder-synced", unnested.folder]);

  const refused = await setParent(db.getMeetingsFolder().id, parent.id);
  assert.equal(refused.success, false);
});

test("subfolder writes from a window are fenced to the account and sign-in that made them", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db } = ctx;

  const parent = await createFolder("Client A");
  const child = await createFolder("Q1");
  const staleGuard = { accountId: "another-account", authGeneration: tokenState.generation };

  const created = await invoke("db-create-folder", "Q2", null, staleGuard, parent.id);
  assert.deepEqual(created, { success: false, error: "Account changed" });
  const nested = await invoke("db-set-folder-parent", child.id, parent.id, staleGuard);
  assert.deepEqual(nested, { success: false, error: "Account changed" });
  assert.equal(db.getFolders().find((f) => f.id === child.id).parent_folder_id, null);
  assert.ok(!db.getFolders().some((f) => f.name === "Q2"));
});

test("pulled parents from a previous sign-in are refused", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db } = ctx;

  const parent = await createFolder("Client A");
  const child = await createFolder("Q1");
  db.markFolderSynced(parent.id, "c-parent");
  db.markFolderSynced(child.id, "c-child");
  await settle();
  sent.length = 0;

  const result = await invoke(
    "db-apply-cloud-folder-parents",
    [
      {
        cloudId: "c-child",
        parentCloudId: "c-parent",
        snapshot: db.getFolderByClientId(child.client_folder_id),
      },
    ],
    tokenState.generation + 1
  );
  await settle();
  assert.equal(result.stale, true);
  assert.equal(db.getFolders().find((f) => f.id === child.id).parent_folder_id, null);
  assert.deepEqual(sent, []);
});

test("deleting a parent announces each deleted folder, subfolders first, and removes their directories", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { privateDir } = ctx;

  const parent = await createFolder("Client A");
  const child = await createFolder("Q1", null, parent.id);
  await settle();
  sent.length = 0;

  const result = await invoke("db-delete-folder", parent.id);
  await settle();
  assert.ok(result.success);
  assert.deepEqual(sent, [
    ["folder-deleted", { id: child.id, noteIds: [] }],
    ["folder-deleted", { id: parent.id, noteIds: [] }],
  ]);
  assert.ok(!fs.existsSync(path.join(privateDir, "Client A")));
  assert.ok(!fs.existsSync(path.join(privateDir, "Q1")));
});

test("hard-deleting a parent takes its surviving subfolder's files to the top level", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const parent = await createFolder("Client A");
  const child = await createFolder("Q1", null, parent.id);
  const note = saveMirroredNote(db, "Plan", child.id);
  await settle();
  writeUserFile(privateDir, "Client A", "Q1", "photo.png");

  assert.ok((await invoke("db-hard-delete-folder", parent.id)).success);
  await settle();
  assert.equal(db.getFolders().find((f) => f.id === child.id).parent_folder_id, null);
  assert.equal(markdownMirror.getNotePath(note.id), notePath(note, privateDir, "Q1"));
  assert.ok(fs.existsSync(path.join(privateDir, "Q1", "photo.png")));
  assert.ok(!fs.existsSync(path.join(privateDir, "Client A")));
});

test("a pulled un-nest announces the folder and moves its notes' files to the top level", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const parent = await createFolder("Client A");
  const child = await createFolder("Q1", null, parent.id);
  db.markFolderSynced(parent.id, "c-parent");
  db.markFolderSynced(child.id, "c-child");
  const note = saveMirroredNote(db, "Plan", child.id);
  await settle();
  sent.length = 0;

  await invoke("db-apply-cloud-folder-parents", [
    {
      cloudId: "c-child",
      parentCloudId: null,
      snapshot: db.getFolderByClientId(child.client_folder_id),
    },
  ]);
  await settle();
  const unnested = db.getFolders().find((f) => f.id === child.id);
  assert.equal(unnested.parent_folder_id, null);
  assert.deepEqual(sent, [["folder-synced", unnested]]);
  assert.equal(markdownMirror.getNotePath(note.id), notePath(note, privateDir, "Q1"));
  assert.ok(!fs.existsSync(path.join(privateDir, "Client A", "Q1")));

  await invoke("db-hard-delete-folder", parent.id);
  await settle();
  assert.equal(markdownMirror.getNotePath(note.id), notePath(note, privateDir, "Q1"));
});

test("a pulled space move takes the subfolder's notes to the new space", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = addTeam(db, "Growth");
  const parent = await createFolder("Client A");
  const child = await createFolder("Q1", null, parent.id);
  const note = saveMirroredNote(db, "Plan", child.id);
  await settle();

  await invoke(
    "db-upsert-folder-from-cloud",
    {
      id: "c-child",
      client_folder_id: child.client_folder_id,
      name: "Q1",
      sort_order: 0,
      created_at: child.created_at,
      updated_at: "2027-01-01T00:00:00.000Z",
    },
    team
  );
  await settle();
  assert.equal(
    markdownMirror.getNotePath(note.id),
    notePath(note, teamDir(basePath, "Growth"), "Q1")
  );
});

test("moving a parent out of a team takes its subfolder and the subfolder's notes", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const team = addTeam(db, "Growth");
  const parent = await createFolder("Client A", team);
  const child = await createFolder("Q1", team, parent.id);
  const note = saveMirroredNote(db, "Plan", child.id);
  await settle();

  writeUserFile(teamDir(ctx.basePath, "Growth"), "Client A", "Q1", "photo.png");

  const moved = await invoke("db-move-folder-to-space", parent.id, db.getPrivateSpaceId());
  await settle();
  assert.ok(moved.success, moved.error);
  assert.equal(db.getFolders().find((f) => f.id === child.id).parent_folder_id, parent.id);
  assert.equal(markdownMirror.getNotePath(note.id), notePath(note, privateDir, "Client A", "Q1"));
  assert.ok(fs.existsSync(path.join(privateDir, "Client A", "Q1", "photo.png")));
  assert.ok(!fs.existsSync(path.join(teamDir(ctx.basePath, "Growth"), "Client A")));
});

test("deleting a private subfolder leaves the team's same-named subfolder's files", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = addTeam(db, "Growth");
  const privateParent = await createFolder("Client A");
  const privateChild = await createFolder("Q1", null, privateParent.id);
  const teamParent = await createFolder("Client A", team);
  const teamChild = await createFolder("Q1", team, teamParent.id);
  const deleted = saveMirroredNote(db, "Deleted", privateChild.id);
  const live = saveMirroredNote(db, "Live", teamChild.id);
  await settle();

  await invoke("db-delete-folder", privateChild.id);
  await settle();
  assert.equal(markdownMirror.getNotePath(deleted.id), null);
  assert.equal(
    markdownMirror.getNotePath(live.id),
    notePath(live, teamDir(basePath, "Growth"), "Client A", "Q1")
  );
});

test("nesting a folder moves its directory, notes and the user's files into its parent's", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const parent = await createFolder("Client A");
  const archive = await createFolder("Archive");
  const note = saveMirroredNote(db, "Plan", archive.id);
  await settle();
  writeUserFile(privateDir, "Archive", "roadmap.txt");
  sent.length = 0;

  const nested = await setParent(archive.id, parent.id);
  await settle();
  assert.equal(nested.folder.parent_folder_id, parent.id);
  assert.deepEqual(sent, [["folder-synced", nested.folder]]);
  assert.equal(
    markdownMirror.getNotePath(note.id),
    notePath(note, privateDir, "Client A", "Archive")
  );
  assert.ok(fs.existsSync(path.join(privateDir, "Client A", "Archive", "roadmap.txt")));
  assert.ok(!fs.existsSync(path.join(privateDir, "Archive")));
});

test("deleting a folder removes its and its subfolders' notes' files and keeps the user's own", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const parent = await createFolder("P");
  const child = await createFolder("Q", null, parent.id);
  const parentNote = saveMirroredNote(db, "Parent", parent.id);
  const childNote = saveMirroredNote(db, "Child", child.id);
  await settle();
  writeUserFile(privateDir, "P", "contract.pdf");
  writeUserFile(privateDir, "P", "Q", "photo.png");

  await invoke("db-delete-folder", parent.id);
  await settle();

  assert.equal(markdownMirror.getNotePath(parentNote.id), null);
  assert.equal(markdownMirror.getNotePath(childNote.id), null);
  assert.deepEqual(filesUnder(path.join(privateDir, "P")), [
    "Q",
    path.join("Q", "photo.png"),
    "contract.pdf",
  ]);
});

test("deleting an unsynced subfolder leaves none of its notes' text behind", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  // An unsynced folder's rows go at once, so its notes' files are removed by id.
  const parent = await createFolder("P");
  const child = await createFolder("Q", null, parent.id);
  const note = saveMirroredNote(db, "Secret", child.id);
  await settle();

  await invoke("db-delete-folder", child.id);
  await settle();

  assert.equal(markdownMirror.getNotePath(note.id), null);
  assert.deepEqual(filesUnder(path.join(privateDir, "P")), []);
});

test("a pulled delete keeps the user's files, and a denied delete restores notes beside them", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const denied = await createFolder("Denied");
  const pulled = await createFolder("Pulled");
  db.markFolderSynced(denied.id, "c-denied");
  db.markFolderSynced(pulled.id, "c-pulled");
  const deniedNote = saveMirroredNote(db, "Kept", denied.id);
  db.markNoteSynced(deniedNote.id, "c-kept");
  const pulledNote = saveMirroredNote(db, "Gone", pulled.id);
  db.markNoteSynced(pulledNote.id, "c-gone");
  await settle();
  writeUserFile(privateDir, "Denied", "mine.txt");
  writeUserFile(privateDir, "Pulled", "mine.txt");

  await invoke("db-hard-delete-folder", pulled.id, undefined, { preserveDirtyNotes: true });
  await settle();
  assert.deepEqual(filesUnder(path.join(privateDir, "Pulled")), ["mine.txt"]);

  await invoke("db-delete-folder", denied.id);
  await settle();
  assert.deepEqual(filesUnder(path.join(privateDir, "Denied")), ["mine.txt"]);
  await invoke("db-restore-folder-after-denied-delete", denied.id);
  await settle();
  assert.ok(markdownMirror.getNotePath(deniedNote.id));
  assert.ok(fs.existsSync(path.join(privateDir, "Denied", "mine.txt")));
});

test("purging a space removes its subfolders' notes' files and keeps the user's", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = addTeam(db, "purged");
  const parent = await createFolder("P", team);
  const child = await createFolder("Q", team, parent.id);
  const unsent = saveMirroredNote(db, "Unsent", child.id);
  const synced = saveMirroredNote(db, "Synced", child.id);
  db.markNoteSynced(synced.id, "c-synced");
  await settle();
  writeUserFile(teamDir(basePath, "purged"), "P", "Q", "photo.png");

  const result = await invoke("db-purge-space", team, {});
  await settle();

  assert.ok(result.success);
  assert.ok(result.relocatedNotes.some((note) => note.id === unsent.id));
  assert.equal(markdownMirror.getNotePath(synced.id), null);
  assert.deepEqual(filesUnder(path.join(teamDir(basePath, "purged"), "P", "Q")), ["photo.png"]);
  assert.ok(
    !markdownMirror.getNotePath(unsent.id).startsWith(teamDir(basePath, "purged")),
    "the relocated note's only copy is the rewritten one"
  );
});

test("deleting an account leaves none of its subfolders' notes' text", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const parent = await createFolder("P");
  const child = await createFolder("Q", null, parent.id);
  const note = saveMirroredNote(db, "Secret", child.id);
  await settle();
  writeUserFile(privateDir, "P", "Q", "photo.png");

  const result = await invoke("delete-account-data", "test-account", tokenState.generation);
  await settle();

  assert.ok(result.success, result.error);
  assert.equal(markdownMirror.getNotePath(note.id), null);
  assert.deepEqual(filesUnder(path.join(privateDir, "P", "Q")), ["photo.png"]);
});

test("renaming a parent moves its directory with its subfolder's notes and files inside", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const parent = await createFolder("P");
  const child = await createFolder("Q", null, parent.id);
  const note = saveMirroredNote(db, "Child", child.id);
  await settle();
  writeUserFile(privateDir, "P", "contract.pdf");
  writeUserFile(privateDir, "P", "Q", "photo.png");

  await invoke("db-rename-folder", parent.id, "R");
  await settle();

  assert.ok(!fs.existsSync(path.join(privateDir, "P")));
  assert.equal(markdownMirror.getNotePath(note.id), notePath(note, privateDir, "R", "Q"));
  assert.ok(fs.existsSync(path.join(privateDir, "R", "contract.pdf")));
  assert.ok(fs.existsSync(path.join(privateDir, "R", "Q", "photo.png")));
  const frontmatter = fs.readFileSync(markdownMirror.getNotePath(note.id), "utf8");
  assert.match(frontmatter, /^folder: "R\/Q"$/m);
});

test("a pulled nest of a parent un-nests its child first and keeps one copy of its notes", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const outer = await createFolder("R");
  const parent = await createFolder("P");
  const child = await createFolder("C", null, parent.id);
  db.markFolderSynced(outer.id, "c-outer");
  db.markFolderSynced(parent.id, "c-parent");
  const note = saveMirroredNote(db, "Child", child.id);
  await settle();
  sent.length = 0;

  await invoke("db-apply-cloud-folder-parents", [
    {
      cloudId: "c-parent",
      parentCloudId: "c-outer",
      snapshot: db.getFolderByClientId(parent.client_folder_id),
    },
  ]);
  await settle();

  const folders = db.getFolders();
  assert.equal(folders.find((f) => f.id === parent.id).parent_folder_id, outer.id);
  assert.equal(folders.find((f) => f.id === child.id).parent_folder_id, null);
  assert.deepEqual(
    sent.filter(([channel]) => channel === "folder-synced").map(([, folder]) => folder.id),
    [child.id, parent.id]
  );
  assert.deepEqual(filesUnder(path.join(privateDir, "C")), [
    `${note.id}-child-transcript.md`,
    `${note.id}-child.md`,
  ]);
  assert.deepEqual(filesUnder(path.join(privateDir, "R")), ["P"]);
  assert.ok(!fs.existsSync(path.join(privateDir, "P")));
});

test("a pulled folder delete moves every note's file to the top level and removes none", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, privateDir } = ctx;

  const folder = await createFolder("Client A");
  db.markFolderSynced(folder.id, "c-client");
  const clean = db.saveNote("Clean", "pushed", "personal", null, null, folder.id).note;
  db.markNoteSynced(clean.id, "c-clean");
  const unsent = db.saveNote("Unsent", "only here", "personal", null, null, folder.id).note;
  target.noteFiles.writeNote(db.getNote(clean.id));
  target.noteFiles.writeNote(unsent);
  await settle();
  sent.length = 0;

  const result = await invoke("db-hard-delete-folder", folder.id, undefined, {
    preserveDirtyNotes: true,
  });
  await settle();

  assert.ok(result.success);
  assert.deepEqual(result.noteIds, []);
  // The server's own note tombstones decide what goes, in the note pull.
  for (const note of [clean, unsent]) {
    assert.equal(
      markdownMirror.getNotePath(note.id),
      notePath(note, privateDir),
      `${note.title}'s file moved with it rather than being deleted`
    );
  }
  assert.ok(!fs.existsSync(path.join(privateDir, "Client A")));
  // The notes reach windows before their folder goes, so one showing them
  // keeps it open.
  assert.deepEqual(
    sent.map(([channel, row]) => [channel, row.id]),
    [
      ["note-updated", clean.id],
      ["note-updated", unsent.id],
      ["folder-deleted", folder.id],
    ]
  );
  assert.equal(sent[0][1].folder_id, null);
});

test("a refused delete announces the unsynced subfolder it restores", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db } = ctx;

  const parent = await createFolder("Client A");
  db.markFolderSynced(parent.id, "c-client");
  const child = await createFolder("Q1", null, parent.id);
  const note = db.saveNote("Plan", "Body", "personal", null, null, child.id).note;
  await invoke("db-delete-folder", parent.id);
  await settle();
  sent.length = 0;

  const result = await invoke("db-restore-folder-after-denied-delete", parent.id);
  await settle();

  assert.ok(result.success);
  assert.deepEqual(
    sent.filter(([channel]) => channel === "folder-synced").map(([, folder]) => folder.id),
    [parent.id, child.id]
  );
  assert.deepEqual(
    sent.filter(([channel]) => channel === "note-synced").map(([, row]) => row.id),
    [note.id]
  );
  assert.notEqual(markdownMirror.getNotePath(note.id), null);
});
