const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// The real folder handler closures over a real DatabaseManager and the real
// markdown mirror (the fake-`this` scaffolding from noteUndoIpc.test.js): a
// subfolder's mirror directory sits inside its parent's and must follow every
// rename, move and delete.
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
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
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
let handlersThis = null;
// Handler setup opens its own databases under userData before any test sets one.
const setupUserData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-subfolder-ipc-"));

test.before(() => {
  setUserDataDir(setupUserData);
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  handlersThis = {
    _noteFilesEnabled: true,
    _mirrorTasks: [],
    _mirrorTaskScheduled: false,
    notifyVectorChanges: () => {},
    get databaseManager() {
      return current.db;
    },
  };
  for (const method of [
    "createFolderWithEffects",
    "_buildFolderMap",
    "_buildSpeakerMappings",
    "_getMirrorFolder",
    "_mirrorFoldersWhere",
    "_mirrorMoveFolder",
    "_mirrorFolderInUse",
    "_mirrorDeleteFolderIfUnshared",
    "_queueMirrorFolderCleanup",
    "_mirrorRewriteNote",
    "_mirrorWriteNote",
    "_enqueueMirrorTask",
    "_scheduleMirrorTask",
    "_asyncMirrorWrite",
    "_asyncMirrorDelete",
  ]) {
    handlersThis[method] = Ctor.prototype[method];
  }
  const self = new Proxy(handlersThis, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
  Ctor.prototype.setupHandlers.call(self);
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(setupUserData, { recursive: true, force: true });
});

function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  db.setActiveAccountId("test-account");
  current.db = db;
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-subfolder-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  markdownMirror.init(basePath);
  sent.length = 0;
  return { db, basePath };
}

// Lets the handlers' deferred work run, then the mirror's queue drain.
const settle = async () => {
  do {
    await new Promise((resolve) => setImmediate(resolve));
  } while (handlersThis._mirrorTasks.length > 0 || handlersThis._mirrorTaskScheduled);
};

const writeUserFile = (...segments) => {
  fs.mkdirSync(path.dirname(path.join(...segments)), { recursive: true });
  fs.writeFileSync(path.join(...segments), "the user's own");
};
const transcript = JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Hello." }]);
const saveMirroredNote = (db, title, folderId, mirrorFolder) => {
  const note = db.saveNote(title, "Body", "personal", null, null, folderId, null, transcript).note;
  markdownMirror.writeNote(note, mirrorFolder);
  markdownMirror.writeTranscript(note, mirrorFolder, {});
  return note;
};
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
const filesUnder = (dirPath) =>
  fs.existsSync(dirPath) ? fs.readdirSync(dirPath, { recursive: true }).sort() : [];

test("creating, renaming and re-parenting a subfolder keeps its mirror directory in its parent's", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "Client A")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q1", null, parent.id)).folder;
  await settle();
  assert.equal(child.parent_folder_id, parent.id);
  assert.ok(fs.statSync(path.join(basePath, "Client A", "Q1")).isDirectory());

  await handlers.get("db-rename-folder")(null, child.id, "Q2");
  await settle();
  assert.ok(fs.existsSync(path.join(basePath, "Client A", "Q2")));
  assert.ok(!fs.existsSync(path.join(basePath, "Client A", "Q1")));

  const unnested = await handlers.get("db-set-folder-parent")(null, child.id, null);
  await settle();
  assert.equal(unnested.folder.parent_folder_id, null);
  assert.ok(fs.existsSync(path.join(basePath, "Q2")));
  assert.ok(!fs.existsSync(path.join(basePath, "Client A", "Q2")));
  assert.deepEqual(sent.at(-1), ["folder-synced", unnested.folder]);

  const refused = await handlers.get("db-set-folder-parent")(
    null,
    db.getMeetingsFolder().id,
    parent.id
  );
  assert.equal(refused.success, false);
});

test("deleting a parent announces each deleted folder and removes the nested directories", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "Client A")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q1", null, parent.id)).folder;
  await settle();
  sent.length = 0;

  const result = await handlers.get("db-delete-folder")(null, parent.id);
  await settle();
  assert.ok(result.success);
  assert.deepEqual(sent, [
    ["folder-deleted", { id: child.id }],
    ["folder-deleted", { id: parent.id }],
  ]);
  assert.ok(!fs.existsSync(path.join(basePath, "Client A")));
});

test("hard-deleting a parent moves its surviving subfolder's files to the top level", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "Client A")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q1", null, parent.id)).folder;
  await settle();
  fs.writeFileSync(path.join(basePath, "Client A", "Q1", "1-plan.md"), "---\nid: 1\n---\n");
  // Another space's top-level "Q1" already has the directory.
  fs.mkdirSync(path.join(basePath, "Q1"));
  fs.writeFileSync(path.join(basePath, "Q1", "2-roadmap.md"), "---\nid: 2\n---\n");

  assert.ok((await handlers.get("db-hard-delete-folder")(null, parent.id)).success);
  await settle();
  assert.equal(ctx.db.getFolders().find((f) => f.id === child.id).parent_folder_id, null);
  assert.ok(fs.existsSync(path.join(basePath, "Q1", "1-plan.md")));
  assert.ok(fs.existsSync(path.join(basePath, "Q1", "2-roadmap.md")));
  assert.ok(!fs.existsSync(path.join(basePath, "Client A")));
});

test("a pulled un-nest moves the subfolder's directory out of its old parent's", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "Client A")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q1", null, parent.id)).folder;
  await settle();
  db.markFolderSynced(parent.id, "c-parent");
  db.markFolderSynced(child.id, "c-child");
  fs.writeFileSync(path.join(basePath, "Client A", "Q1", "1-plan.md"), "---\nid: 1\n---\n");

  await handlers.get("db-apply-cloud-folder-parents")(null, [
    {
      cloudId: "c-child",
      parentCloudId: null,
      snapshot: db.getFolderByClientId(child.client_folder_id),
    },
  ]);
  await settle();
  await handlers.get("db-hard-delete-folder")(null, parent.id);
  await settle();
  assert.ok(fs.existsSync(path.join(basePath, "Q1", "1-plan.md")));
});

test("a pulled space move takes the subfolder's directory out of its old parent's", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, 1)"
    )
    .run("team-pulled-move", "Growth");
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team.lastInsertRowid, "test-account");
  const parent = (await handlers.get("db-create-folder")(null, "Client A")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q1", null, parent.id)).folder;
  const note = db.saveNote("Plan", "Body", "personal", null, null, child.id).note;
  markdownMirror.writeNote(note, ["Client A", "Q1"]);
  await settle();

  await handlers.get("db-upsert-folder-from-cloud")(
    null,
    {
      id: "c-child",
      client_folder_id: child.client_folder_id,
      name: "Q1",
      sort_order: 0,
      created_at: child.created_at,
      updated_at: "2027-01-01T00:00:00.000Z",
    },
    team.lastInsertRowid
  );
  await settle();
  assert.equal(
    markdownMirror.getNotePath(note.id),
    path.join(basePath, "Q1", `${note.id}-plan.md`)
  );
});

test("moving a parent out of a team keeps its subfolder's directory inside the parent's", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, 1)"
    )
    .run("team-moved-out", "Growth");
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team.lastInsertRowid, "test-account");
  const parent = (await handlers.get("db-create-folder")(null, "Client A", team.lastInsertRowid))
    .folder;
  const child = (
    await handlers.get("db-create-folder")(null, "Q1", team.lastInsertRowid, parent.id)
  ).folder;
  const note = db.saveNote("Plan", "Body", "personal", null, null, child.id).note;
  markdownMirror.writeNote(note, ["Client A", "Q1"]);
  await settle();

  const moved = await handlers.get("db-move-folder-to-space")(
    null,
    parent.id,
    db.getPrivateSpaceId()
  );
  await settle();
  assert.ok(moved.success);
  assert.equal(db.getFolders().find((f) => f.id === child.id).parent_folder_id, parent.id);
  assert.equal(
    markdownMirror.getNotePath(note.id),
    path.join(basePath, "Client A", "Q1", `${note.id}-plan.md`)
  );
});

test("a subfolder's directory survives while another space's folder shares its path", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, 1)"
    )
    .run("team-shared-path", "Growth");
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team.lastInsertRowid, "test-account");
  const privateParent = db.createFolder("Client A").folder;
  const privateChild = db.createFolder("Q1", null, privateParent.id).folder;
  const teamParent = db.createFolder("Client A", team.lastInsertRowid).folder;
  db.createFolder("Q1", team.lastInsertRowid, teamParent.id);
  markdownMirror.ensureFolder(["Client A", "Q1"]);

  await handlers.get("db-delete-folder")(null, privateChild.id);
  await settle();
  assert.ok(fs.existsSync(path.join(basePath, "Client A", "Q1")));
});

test("nesting a folder leaves the directory another space's same-named folder shares", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, 1)"
    )
    .run("team-shared-move", "Growth");
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team.lastInsertRowid, "test-account");
  const parent = (await handlers.get("db-create-folder")(null, "Client A")).folder;
  const archive = (await handlers.get("db-create-folder")(null, "Archive")).folder;
  await handlers.get("db-create-folder")(null, "Archive", team.lastInsertRowid);
  const note = db.saveNote("Plan", "Body", "personal", null, null, archive.id).note;
  markdownMirror.writeNote(note, "Archive");
  await settle();
  fs.writeFileSync(path.join(basePath, "Archive", "77-roadmap.md"), "---\nid: 77\n---\n");

  await handlers.get("db-set-folder-parent")(null, archive.id, parent.id);
  await settle();
  assert.ok(fs.existsSync(path.join(basePath, "Archive", "77-roadmap.md")));
  assert.equal(
    markdownMirror.getNotePath(note.id),
    path.join(basePath, "Client A", "Archive", `${note.id}-plan.md`),
    "the nested folder's own notes are rewritten at its new path"
  );
});

// Whether two names are one directory is the file system's call, and no name
// comparison gets all of them: APFS folds each of these pairs together.
for (const [personalName, teamName] of [
  ["Straße", "STRASSE"],
  ["ſtudio", "studio"],
  ["ﬁles", "files"],
  ["λόγος", "ΛΌΓΟΣ"],
  ["µ", "μ"],
  ["Caf\u00e9", "Cafe\u0301"],
  ["Été", "été"],
]) {
  test(`deleting the team's ${teamName} leaves the file of a live note in ${personalName}`, async (t) => {
    const ctx = setup(t);
    if (!ctx) return;
    const { db, basePath } = ctx;

    const team = addTeam(db, "same-directory");
    const personal = (await handlers.get("db-create-folder")(null, personalName)).folder;
    const teamFolder = (await handlers.get("db-create-folder")(null, teamName, team)).folder;
    await settle();
    const live = saveMirroredNote(db, "Live", personal.id, personalName);
    const deleted = saveMirroredNote(db, "Deleted", teamFolder.id, teamName);
    const sharesDirectory =
      fs.statSync(path.join(basePath, personalName)).ino ===
      fs.statSync(path.join(basePath, teamName)).ino;

    await handlers.get("db-delete-folder")(null, teamFolder.id);
    await settle();

    assert.ok(markdownMirror.getNotePath(live.id), "the live note's file stays");
    assert.equal(markdownMirror.getNotePath(deleted.id), null, "the deleted note's file goes");
    assert.equal(fs.existsSync(path.join(basePath, teamName)), sharesDirectory);
  });

  test(`renaming the team's ${teamName} leaves a live note in ${personalName} where it is`, async (t) => {
    const ctx = setup(t);
    if (!ctx) return;
    const { db, basePath } = ctx;

    const team = addTeam(db, "same-directory-rename");
    const personal = (await handlers.get("db-create-folder")(null, personalName)).folder;
    const teamFolder = (await handlers.get("db-create-folder")(null, teamName, team)).folder;
    await settle();
    const live = saveMirroredNote(db, "Live", personal.id, personalName);
    const moved = saveMirroredNote(db, "Moved", teamFolder.id, teamName);

    await handlers.get("db-rename-folder")(null, teamFolder.id, "Renamed");
    await settle();

    assert.equal(
      markdownMirror.getNotePath(live.id),
      path.join(basePath, personalName, `${live.id}-live.md`)
    );
    assert.equal(
      markdownMirror.getNotePath(moved.id),
      path.join(basePath, "Renamed", `${moved.id}-moved.md`)
    );
  });
}

test("deleting a folder removes its notes' files and keeps the user's own", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "P")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q", null, parent.id)).folder;
  await settle();
  const parentNote = saveMirroredNote(db, "Parent", parent.id, "P");
  const childNote = saveMirroredNote(db, "Child", child.id, ["P", "Q"]);
  writeUserFile(basePath, "P", "contract.pdf");
  writeUserFile(basePath, "P", "Q", "photo.png");

  await handlers.get("db-delete-folder")(null, parent.id);
  await settle();

  assert.equal(markdownMirror.getNotePath(parentNote.id), null);
  assert.equal(markdownMirror.getNotePath(childNote.id), null);
  assert.deepEqual(filesUnder(path.join(basePath, "P")), [
    "Q",
    path.join("Q", "photo.png"),
    "contract.pdf",
  ]);
});

test("a folder delete leaves no note text in a subfolder the database already forgot", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  // An unsynced folder's rows go at once, so by the time its notes' files are
  // removed no scan reaches the subfolder's directory.
  const parent = (await handlers.get("db-create-folder")(null, "P")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q", null, parent.id)).folder;
  await settle();
  saveMirroredNote(db, "Secret", child.id, ["P", "Q"]);

  await handlers.get("db-delete-folder")(null, child.id);
  await settle();

  assert.deepEqual(filesUnder(path.join(basePath, "P")), []);
});

test("a pulled delete keeps the user's files, and a denied delete restores notes beside them", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const denied = (await handlers.get("db-create-folder")(null, "Denied")).folder;
  const pulled = (await handlers.get("db-create-folder")(null, "Pulled")).folder;
  await settle();
  db.markFolderSynced(denied.id, "c-denied");
  db.markFolderSynced(pulled.id, "c-pulled");
  const deniedNote = saveMirroredNote(db, "Kept", denied.id, "Denied");
  db.markNoteSynced(deniedNote.id, "c-kept");
  const pulledNote = saveMirroredNote(db, "Gone", pulled.id, "Pulled");
  db.markNoteSynced(pulledNote.id, "c-gone");
  writeUserFile(basePath, "Denied", "mine.txt");
  writeUserFile(basePath, "Pulled", "mine.txt");

  await handlers.get("db-hard-delete-folder")(null, pulled.id, { preserveDirtyNotes: true });
  await settle();
  assert.deepEqual(filesUnder(path.join(basePath, "Pulled")), ["mine.txt"]);

  await handlers.get("db-delete-folder")(null, denied.id);
  await settle();
  assert.deepEqual(filesUnder(path.join(basePath, "Denied")), ["mine.txt"]);
  await handlers.get("db-restore-folder-after-denied-delete")(null, denied.id);
  await settle();
  assert.ok(markdownMirror.getNotePath(deniedNote.id));
  assert.ok(fs.existsSync(path.join(basePath, "Denied", "mine.txt")));
});

test("purging a space removes its notes' files, subfolders' too, and keeps the user's", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = addTeam(db, "purged");
  const parent = (await handlers.get("db-create-folder")(null, "P", team)).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q", team, parent.id)).folder;
  await settle();
  saveMirroredNote(db, "Removed", child.id, ["P", "Q"]);
  const unsent = saveMirroredNote(db, "Unsent", child.id, ["P", "Q"]);
  const synced = saveMirroredNote(db, "Synced", child.id, ["P", "Q"]);
  db.markNoteSynced(synced.id, "c-synced");
  writeUserFile(basePath, "P", "Q", "photo.png");

  const result = await handlers.get("db-purge-space")(null, team, {});
  await settle();

  assert.ok(result.success);
  assert.ok(result.relocatedNotes.some((note) => note.id === unsent.id));
  assert.deepEqual(filesUnder(path.join(basePath, "P")), ["Q", path.join("Q", "photo.png")]);
  assert.equal(
    path.dirname(markdownMirror.getNotePath(unsent.id)),
    path.join(basePath, "Personal"),
    "the relocated note's only copy is the rewritten one"
  );
});

test("deleting an account leaves none of its notes' text in subfolder directories", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "P")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q", null, parent.id)).folder;
  await settle();
  saveMirroredNote(db, "Secret", child.id, ["P", "Q"]);
  writeUserFile(basePath, "P", "Q", "photo.png");

  const result = await handlers.get("delete-account-data")(
    {},
    "test-account",
    tokenState.generation
  );
  await settle();

  assert.ok(result.success, result.error);
  assert.deepEqual(filesUnder(path.join(basePath, "P")), ["Q", path.join("Q", "photo.png")]);
});

test("a shared parent's rename rewrites its subfolder's notes and removes the old copies", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = addTeam(db, "shared-rename");
  const parent = (await handlers.get("db-create-folder")(null, "P")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q", null, parent.id)).folder;
  await handlers.get("db-create-folder")(null, "P", team);
  await settle();
  const note = saveMirroredNote(db, "Child", child.id, ["P", "Q"]);
  writeUserFile(basePath, "P", "Q", "photo.png");

  await handlers.get("db-rename-folder")(null, parent.id, "R");
  await settle();

  assert.equal(
    markdownMirror.getNotePath(note.id),
    path.join(basePath, "R", "Q", `${note.id}-child.md`)
  );
  assert.deepEqual(filesUnder(path.join(basePath, "P")), ["Q", path.join("Q", "photo.png")]);

  markdownMirror.deleteNote(note.id);
  assert.deepEqual(filesUnder(path.join(basePath, "R", "Q")), []);
});

test("a failed move out of a parent leaves no old copy a later delete can't find", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "P")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q", null, parent.id)).folder;
  await settle();
  const note = saveMirroredNote(db, "Child", child.id, ["P", "Q"]);
  writeUserFile(basePath, "P", "Q", "photo.png");
  const renameSync = t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });

  await handlers.get("db-set-folder-parent")(null, child.id, null);
  await settle();
  renameSync.mock.restore();

  assert.deepEqual(filesUnder(path.join(basePath, "P", "Q")), ["photo.png"]);
  assert.equal(
    markdownMirror.getNotePath(note.id),
    path.join(basePath, "Q", `${note.id}-child.md`)
  );
});

test("a merge that leaves a note's copy behind removes it once the note is rewritten", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "P")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q", null, parent.id)).folder;
  await settle();
  const note = saveMirroredNote(db, "Child", child.id, ["P", "Q"]);
  fs.mkdirSync(path.join(basePath, "Q"));
  fs.copyFileSync(
    path.join(basePath, "P", "Q", `${note.id}-child.md`),
    path.join(basePath, "Q", `${note.id}-child.md`)
  );

  await handlers.get("db-set-folder-parent")(null, child.id, null);
  await settle();

  assert.deepEqual(filesUnder(path.join(basePath, "P")), []);
  assert.deepEqual(filesUnder(path.join(basePath, "Q")), [
    `${note.id}-child-transcript.md`,
    `${note.id}-child.md`,
  ]);
  assert.match(fs.readFileSync(markdownMirror.getNotePath(note.id), "utf-8"), /Body$/);
});

test("a pulled nest of a parent moves its un-nested child out first, leaving one copy", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const outer = (await handlers.get("db-create-folder")(null, "R")).folder;
  const parent = (await handlers.get("db-create-folder")(null, "P")).folder;
  const child = (await handlers.get("db-create-folder")(null, "C", null, parent.id)).folder;
  await settle();
  db.markFolderSynced(outer.id, "c-outer");
  db.markFolderSynced(parent.id, "c-parent");
  const note = saveMirroredNote(db, "Child", child.id, ["P", "C"]);

  await handlers.get("db-apply-cloud-folder-parents")(null, [
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
  assert.deepEqual(filesUnder(path.join(basePath, "R")), ["P"]);
  assert.deepEqual(filesUnder(path.join(basePath, "C")), [
    `${note.id}-child-transcript.md`,
    `${note.id}-child.md`,
  ]);

  markdownMirror.deleteNote(note.id);
  assert.deepEqual(filesUnder(path.join(basePath, "C")), []);
  assert.deepEqual(filesUnder(path.join(basePath, "R")), ["P"]);
});

test("a rewrite writes one note per event-loop turn and follows the note at its turn", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const team = addTeam(db, "shared-spread");
  const folder = (await handlers.get("db-create-folder")(null, "A")).folder;
  const other = (await handlers.get("db-create-folder")(null, "Elsewhere")).folder;
  await handlers.get("db-create-folder")(null, "A", team);
  await settle();
  const notes = ["One", "Two", "Three", "Four", "Five", "Six"].map((title) =>
    saveMirroredNote(db, title, folder.id, "A")
  );
  writeUserFile(basePath, "A", "mine.txt");

  let turn = 0;
  let countingTurns = true;
  const countTurn = () => {
    turn++;
    if (countingTurns) setImmediate(countTurn);
  };
  setImmediate(countTurn);
  t.after(() => {
    countingTurns = false;
  });
  const writeTurns = [];
  const realWriteNote = markdownMirror.writeNote;
  const writeNote = t.mock.method(markdownMirror, "writeNote", (...args) => {
    writeTurns.push(turn);
    return realWriteNote.apply(markdownMirror, args);
  });
  const failing = notes[1].id;
  const realWriteTranscript = markdownMirror.writeTranscript;
  t.mock.method(markdownMirror, "writeTranscript", (note, ...rest) => {
    if (note.id === failing) throw new Error("disk full");
    return realWriteTranscript.call(markdownMirror, note, ...rest);
  });

  await handlers.get("db-rename-folder")(null, folder.id, "B");
  // Only the move has run, so what happens to these two reaches the rewrites.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writeNote.mock.callCount(), 0);
  db.deleteNote(notes[2].id);
  handlersThis._asyncMirrorDelete(notes[2].id);
  db.updateNote(notes[3].id, { folder_id: other.id });

  await settle();

  assert.equal(new Set(writeTurns).size, writeTurns.length, "one write per event-loop turn");
  assert.deepEqual(
    writeNote.mock.calls.map((call) => call.arguments[0].id),
    [notes[0].id, notes[1].id, notes[4].id, notes[5].id],
    "a deleted or moved note isn't written, and a failed write doesn't stop the rest"
  );
  assert.equal(markdownMirror.getNotePath(notes[2].id), null);
  assert.equal(path.dirname(markdownMirror.getNotePath(notes[0].id)), path.join(basePath, "B"));
  assert.ok(fs.existsSync(path.join(basePath, "A", "mine.txt")));
});

test("a cleanup queued behind a failed move runs after that move's rewrites", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "P")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q", null, parent.id)).folder;
  await settle();
  const notes = ["One", "Two", "Three"].map((title) =>
    saveMirroredNote(db, title, child.id, ["P", "Q"])
  );
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });

  assert.ok((await handlers.get("db-hard-delete-folder")(null, parent.id)).success);
  await settle();

  for (const note of notes) {
    assert.equal(path.dirname(markdownMirror.getNotePath(note.id)), path.join(basePath, "Q"));
  }
  assert.ok(!fs.existsSync(path.join(basePath, "P")));
});

test("a subfolder whose directory can't move out of a deleted parent is rewritten at the top level", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "Client A")).folder;
  const child = (await handlers.get("db-create-folder")(null, "Q1", null, parent.id)).folder;
  const note = db.saveNote("Plan", "Body", "personal", null, null, child.id).note;
  markdownMirror.writeNote(note, ["Client A", "Q1"]);
  await settle();
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });

  assert.ok((await handlers.get("db-hard-delete-folder")(null, parent.id)).success);
  await settle();
  assert.equal(
    markdownMirror.getNotePath(note.id),
    path.join(basePath, "Q1", `${note.id}-plan.md`)
  );
  assert.ok(!fs.existsSync(path.join(basePath, "Client A")));
});

test("a pulled folder delete rewrites preserved notes' files and removes only the clean ones'", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, basePath } = ctx;

  const folder = (await handlers.get("db-create-folder")(null, "Client A")).folder;
  db.markFolderSynced(folder.id, "c-client");
  const clean = db.saveNote("Clean", "pushed", "personal", null, null, folder.id).note;
  db.markNoteSynced(clean.id, "c-clean");
  const unsent = db.saveNote("Unsent", "only here", "personal", null, null, folder.id).note;
  markdownMirror.writeNote(clean, "Client A");
  markdownMirror.writeNote(unsent, "Client A");
  await settle();
  sent.length = 0;

  const result = await handlers.get("db-hard-delete-folder")(null, folder.id, {
    preserveDirtyNotes: true,
  });
  await settle();

  assert.ok(result.success);
  assert.deepEqual(result.noteIds, [clean.id]);
  assert.equal(markdownMirror.getNotePath(clean.id), null);
  assert.equal(
    markdownMirror.getNotePath(unsent.id),
    path.join(basePath, "Personal", `${unsent.id}-unsent.md`),
    "the preserved note's file moved with it rather than being deleted after the rewrite"
  );
  assert.ok(!fs.existsSync(path.join(basePath, "Client A")));
  const updated = sent.filter(([channel]) => channel === "note-updated");
  assert.deepEqual(
    updated.map(([, note]) => note.id),
    [unsent.id]
  );
  assert.equal(updated[0][1].folder_id, null);
  assert.deepEqual(
    sent.filter(([channel]) => channel === "folder-deleted"),
    [["folder-deleted", { id: folder.id }]]
  );
});

test("a refused delete announces the unsynced subfolder it restores", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db } = ctx;

  const parent = (await handlers.get("db-create-folder")(null, "Client A")).folder;
  db.markFolderSynced(parent.id, "c-client");
  const child = (await handlers.get("db-create-folder")(null, "Q1", null, parent.id)).folder;
  const note = db.saveNote("Plan", "Body", "personal", null, null, child.id).note;
  await handlers.get("db-delete-folder")(null, parent.id);
  await settle();
  sent.length = 0;

  const result = await handlers.get("db-restore-folder-after-denied-delete")(null, parent.id);
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
  assert.equal(markdownMirror.getNotePath(note.id) !== null, true);
});
