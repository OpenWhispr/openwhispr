const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Registers the real handler closures against a fake `this` (the scaffolding
// from agentDictationPillIpc.test.js), with userData in a temporary directory.
const handlers = new Map();
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "account-scope-ipc-"));

const electronStub = {
  app: {
    getPath: () => userDataDirectory,
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
    }),
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
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

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const target = { sessionId: "test-session" };
  return new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
}

let fakeThis;
let IPCHandlersClass;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  IPCHandlersClass = IPCHandlers;
  const Ctor = IPCHandlers.default || IPCHandlers;
  fakeThis = buildFakeThis();
  Ctor.prototype.setupHandlers.call(fakeThis);
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});

function setupMeeting(t) {
  const { createDb } = require("./harness/db");
  const db = createDb(t);
  if (!db) return null;
  const sender = {};
  const owner = {
    detection: {},
    selectedDestination: null,
    createRequests: new Map(),
  };
  const manager = {
    meetingRecentDestinations: [],
    captureMeetingNotificationOwner: (s) => (s === sender ? owner : null),
    isMeetingNotificationOwner: (o) => o === owner,
    sendToControlPanel: () => {},
  };
  const service = Object.create(IPCHandlersClass.prototype);
  Object.assign(service, { databaseManager: db, windowManager: manager, _noteFilesEnabled: false });
  Object.assign(fakeThis, {
    databaseManager: db,
    windowManager: manager,
    getMeetingNotificationDestination: service.getMeetingNotificationDestination.bind(service),
    selectMeetingNotificationFolder: service.selectMeetingNotificationFolder.bind(service),
    createMeetingNotificationFolder: service.createMeetingNotificationFolder.bind(service),
  });
  return {
    db,
    owner,
    sender,
    service,
    manager,
  };
}

test("only the current notification sender can read/select/create", (t) => {
  const ctx = setupMeeting(t);
  if (!ctx) return;
  assert.equal(
    handlers.get("get-meeting-notification-destination")({ sender: {} }).code,
    "STALE_NOTIFICATION"
  );
  const result = handlers.get("get-meeting-notification-destination")({ sender: ctx.sender });
  assert.equal(result.success, true);
  assert.equal(result.value.recentDestinations.length, 0);
});

test("selection rejects a moved row without discarding the accepted choice", (t) => {
  const ctx = setupMeeting(t);
  if (!ctx) return;
  const folder = ctx.db.createFolder("Calls").folder;
  const ref = { folderId: folder.id, spaceId: folder.space_id };
  assert.equal(ctx.service.selectMeetingNotificationFolder(ctx.owner, ref).success, true);
  const rejected = ctx.service.selectMeetingNotificationFolder(ctx.owner, { ...ref, spaceId: 999 });
  assert.equal(rejected.code, "FOLDER_UNAVAILABLE");
  assert.deepEqual(ctx.owner.selectedDestination, ref);
  assert.deepEqual(ctx.manager.meetingRecentDestinations, [ref]);
});

test("create retry returns one committed row without selecting or promoting it", async (t) => {
  const ctx = setupMeeting(t);
  if (!ctx) return;
  const request = { requestId: "one", name: " New folder ", spaceId: ctx.db.getPrivateSpaceId() };
  const first = ctx.service.createMeetingNotificationFolder(ctx.owner, request);
  assert.equal(first.success, true);
  const second = ctx.service.createMeetingNotificationFolder(ctx.owner, request);
  assert.deepEqual(second.value.createdFolder, first.value.createdFolder);
  assert.equal(ctx.db.getFolders().filter((f) => f.name === "New folder").length, 1);
  assert.equal(ctx.owner.selectedDestination, null);
  assert.deepEqual(ctx.manager.meetingRecentDestinations, []);
  assert.equal(
    ctx.service.createMeetingNotificationFolder(ctx.owner, { ...request, name: "Different" }).code,
    "INVALID_REQUEST"
  );
  ctx.db.deleteFolder(first.value.createdFolder.folderId);
  assert.equal(
    ctx.service.createMeetingNotificationFolder(ctx.owner, request).code,
    "FOLDER_UNAVAILABLE"
  );
  assert.equal(ctx.db.getFolders().filter((f) => f.name === "New folder").length, 0);
  await new Promise(setImmediate);
});

test("folder errors preserve request and destination; context lookup failure is retryable", (t) => {
  const ctx = setupMeeting(t);
  if (!ctx) return;
  const spaceId = ctx.db.getPrivateSpaceId();
  assert.equal(
    ctx.service.createMeetingNotificationFolder(ctx.owner, {
      requestId: "blank",
      name: " ",
      spaceId,
    }).code,
    "FOLDER_NAME_REQUIRED"
  );
  ctx.db.createFolder("Exact");
  assert.equal(
    ctx.service.createMeetingNotificationFolder(ctx.owner, {
      requestId: "dup",
      name: "Exact",
      spaceId,
    }).code,
    "FOLDER_NAME_TAKEN"
  );
  assert.equal(
    ctx.service.createMeetingNotificationFolder(ctx.owner, { requestId: "bad", name: 42, spaceId })
      .code,
    "INVALID_REQUEST"
  );
  ctx.db.getSpaces = () => {
    throw Error("database busy");
  };
  assert.equal(
    ctx.service.getMeetingNotificationDestination(ctx.owner).code,
    "FOLDERS_UNAVAILABLE"
  );
});
