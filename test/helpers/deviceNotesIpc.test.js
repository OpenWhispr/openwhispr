const { withDevicePolicy } = require("./harness/devicePolicy");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Registers the real handler closures against a fake `this` (the scaffolding
// from noteUndoIpc.test.js): moving or claiming a device note must reach every
// window, the search index and the mirror like any other note write.
const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const sent = [];

const electronStub = {
  app: {
    getPath: () => "/tmp",
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
      return [
        {
          isDestroyed: () => false,
          webContents: {
            send: (channel, data) => {
              if (channel !== "effective-policy-changed") sent.push([channel, data]);
            },
          },
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

const MOVED_ROW = { id: 4, title: "Kept on this device" };
const calls = { database: [], notesMoved: 0, vectors: 0 };
let activeAccountId = "account-1";
let moveResult;
let claimResult;
let deviceNotes;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const target = {
    notifyVectorChanges: () => calls.vectors++,
    noteFiles: {
      notesMoved: () => calls.notesMoved++,
    },
    databaseManager: {
      get activeAccountId() {
        return activeAccountId;
      },
      getDeviceNotes: () => deviceNotes,
      moveDeviceNotesToPrivate: (request) => {
        calls.database.push(["move", request]);
        return moveResult;
      },
      resolveStandInOwnership: (...args) => {
        calls.database.push(["resolve", args]);
        return claimResult;
      },
    },
  };
  Ctor.prototype.setupHandlers.call(
    withDevicePolicy(
      new Proxy(target, {
        get: (value, property) => (property in value ? value[property] : anything()),
      })
    )
  );
});

test.after(() => {
  Module._load = originalLoad;
});

test.beforeEach(() => {
  sent.length = 0;
  calls.database.length = 0;
  calls.notesMoved = 0;
  calls.vectors = 0;
  activeAccountId = "account-1";
});

const invoke = async (channel, ...args) => {
  const result = await handlers.get(channel)(null, ...args);
  await new Promise((resolve) => setImmediate(resolve));
  return result;
};

test("db-get-device-notes passes the database result through", async () => {
  deviceNotes = { folders: [{ id: 1, name: "Ideas", noteCount: 2 }], notes: [] };
  assert.equal(await invoke("db-get-device-notes"), deviceNotes);
});

test("db-move-device-notes refuses another account's request", async () => {
  const result = await invoke("db-move-device-notes", { noteIds: [4], accountId: "account-2" });
  assert.equal(result.success, false);
  assert.equal(result.code, "ACCOUNT_CHANGED");
  assert.deepEqual(calls.database, []);
});

test("db-move-device-notes refuses a request that names no notes, which would move them all", async () => {
  for (const request of [{ accountId: "account-1" }, { noteIds: [], accountId: "account-1" }]) {
    const result = await invoke("db-move-device-notes", request);
    assert.equal(result.success, false);
    assert.equal(result.code, "invalid_request");
  }
  assert.deepEqual(calls.database, []);
});

test("db-move-device-notes refuses malformed ids", async () => {
  for (const request of [
    { noteIds: ["4"], accountId: "account-1" },
    { folderId: 0, accountId: "account-1" },
    { noteIds: [4], workspaceId: 7, accountId: "account-1" },
    { noteIds: [4], targetFolderId: "9", accountId: "account-1" },
  ]) {
    assert.equal((await invoke("db-move-device-notes", request)).code, "invalid_request");
  }
  assert.deepEqual(calls.database, []);
});

test("db-move-device-notes broadcasts after a move", async () => {
  moveResult = { moved: [MOVED_ROW], skipped: 1 };
  const result = await invoke("db-move-device-notes", {
    noteIds: [4, 5],
    workspaceId: "workspace-1",
    accountId: "account-1",
  });
  assert.deepEqual(result, { success: true, moved: [MOVED_ROW], skipped: 1 });
  assert.deepEqual(calls.database, [
    [
      "move",
      {
        noteIds: [4, 5],
        folderId: undefined,
        workspaceId: "workspace-1",
        targetFolderId: undefined,
      },
    ],
  ]);
  assert.deepEqual(sent, [
    ["note-updated", MOVED_ROW],
    ["device-notes-changed", undefined],
  ]);
  assert.equal(calls.notesMoved, 1);
  assert.equal(calls.vectors, 1);
});

test("db-move-device-notes with nothing moved broadcasts nothing", async () => {
  moveResult = { moved: [], skipped: 2 };
  const result = await invoke("db-move-device-notes", { folderId: 3, accountId: "account-1" });
  assert.deepEqual(result, { success: true, moved: [], skipped: 2 });
  assert.deepEqual(sent, []);
  assert.equal(calls.notesMoved, 0);
  assert.equal(calls.vectors, 0);
});

test("db-move-device-notes into a folder the account can't file in moves and broadcasts nothing", async () => {
  moveResult = { moved: [], skipped: 1, code: "folder_unavailable" };
  const result = await invoke("db-move-device-notes", {
    noteIds: [4],
    targetFolderId: 9,
    accountId: "account-1",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "folder_unavailable");
  assert.equal(calls.database[0][1].targetFolderId, 9);
  assert.deepEqual(sent, []);
  assert.equal(calls.notesMoved, 0);
});

test("db-resolve-stand-in-ownership broadcasts only when claimed", async () => {
  const request = { noteId: 4, cloudId: "cloud-4", owned: true, accountId: "account-1" };
  claimResult = { claimed: false };
  assert.deepEqual(await invoke("db-resolve-stand-in-ownership", request), { claimed: false });
  assert.deepEqual(sent, []);
  assert.equal(calls.notesMoved, 0);

  claimResult = { claimed: true, note: MOVED_ROW };
  assert.deepEqual(await invoke("db-resolve-stand-in-ownership", request), { claimed: true });
  assert.deepEqual(calls.database.at(-1), ["resolve", [4, "cloud-4", true]]);
  assert.deepEqual(sent, [
    ["note-updated", MOVED_ROW],
    ["device-notes-changed", undefined],
  ]);
  assert.equal(calls.notesMoved, 1);
  assert.equal(calls.vectors, 1);
});

test("db-resolve-stand-in-ownership keeps a claimed tombstone out of note-updated", async () => {
  const request = { noteId: 4, cloudId: "cloud-4", owned: true, accountId: "account-1" };
  claimResult = { claimed: true, note: { ...MOVED_ROW, deleted_at: "2026-01-02 03:04:05" } };
  await invoke("db-resolve-stand-in-ownership", request);
  assert.deepEqual(sent, [["device-notes-changed", undefined]]);
  assert.equal(calls.notesMoved, 1);
  assert.equal(calls.vectors, 1);
});

test("db-resolve-stand-in-ownership refuses another account and malformed arguments", async () => {
  const valid = { noteId: 4, cloudId: "cloud-4", owned: true, accountId: "account-1" };
  const other = await invoke("db-resolve-stand-in-ownership", { ...valid, accountId: "account-2" });
  assert.equal(other.code, "ACCOUNT_CHANGED");
  for (const bad of [{ noteId: "4" }, { cloudId: "" }, { owned: "yes" }]) {
    const result = await invoke("db-resolve-stand-in-ownership", { ...valid, ...bad });
    assert.equal(result.code, "invalid_request");
  }
  assert.deepEqual(calls.database, []);
});
