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
// Handler setup opens its own databases under userData before any test sets one.
const setupUserData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-subfolder-ipc-"));

test.before(() => {
  setUserDataDir(setupUserData);
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const target = {
    _noteFilesEnabled: true,
    notifyVectorChanges: () => {},
    _asyncMirrorWrite: () => {},
    get databaseManager() {
      return current.db;
    },
  };
  for (const method of [
    "createFolderWithEffects",
    "_getMirrorFolder",
    "_mirrorMoveFolder",
    "_mirrorDeleteFolderIfUnshared",
  ]) {
    target[method] = Ctor.prototype[method];
  }
  const self = new Proxy(target, {
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

const settle = () => new Promise((resolve) => setImmediate(resolve));

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
