// The account-scoped sync handlers as main registers them, over a real
// database: the sign-in fence on push acks and pulled rows, chat acks recorded
// for the account that sent them, the scoped audio deletes, the seed IPCs, and
// the dictionary and snippets every window receives when the account changes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// First: its electron stub is what DatabaseManager loads against.
const { createDb } = require("./harness/db.js");
const { call } = require("./harness/cliBridge.js");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const broadcasts = [];
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "account-scoped-sync-ipc-"));
let tokenState = { token: "token-a", generation: 3 };

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
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
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
  if (parent?.filename === handlersModulePath) {
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
        subscribe: () => () => {},
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: (channel, data) => broadcasts.push([channel, data]) };
    }
  }
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

const deletedAudio = [];
const target = {
  sessionId: "test-session",
  databaseManager: null,
  audioStorageManager: {
    deleteAudio: (id) => {
      deletedAudio.push(id);
      return { success: true };
    },
  },
};
let handleAuthTokenChange;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target._broadcastAccountScopedSettings = Ctor.prototype._broadcastAccountScopedSettings;
  const fakeThis = new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
  Ctor.prototype.setupHandlers.call(fakeThis);
  handleAuthTokenChange = (state) => Ctor.prototype._handleAuthTokenChange.call(fakeThis, state);
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});

function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  target.databaseManager = db;
  tokenState = { token: "token-a", generation: 3 };
  broadcasts.length = 0;
  deletedAudio.length = 0;
  return db;
}

const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);

test("a push ack or pulled row from a replaced sign-in is refused", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const stale = 2;
  const word = { id: "dict-1", word: "Kubernetes", client_dict_id: "a-dict" };

  const refused = [
    await invoke("db-upsert-dictionary-from-cloud", word, stale),
    await invoke(
      "db-upsert-snippet-from-cloud",
      { id: "snip-1", trigger: "addr", replacement: "A's address" },
      stale
    ),
    await invoke(
      "db-upsert-transcription-from-cloud",
      { id: "t-1", client_transcription_id: "a-t", text: "hello" },
      stale
    ),
    await invoke(
      "db-upsert-conversation-from-cloud",
      { id: "c-1", client_conversation_id: "a-chat", title: "A's chat" },
      [],
      stale
    ),
    await invoke("db-mark-transcription-synced", 1, "t-1", stale),
    await invoke("db-mark-dictionary-synced", 1, "dict-1", null, null, null, null, stale),
    await invoke("db-mark-snippet-synced", 1, "snip-1", null, null, null, stale),
  ];
  for (const result of refused) assert.equal(result?.stale, true);
  assert.deepEqual(db.getDictionary(), []);
  assert.deepEqual(db.getSnippets(), []);
  assert.deepEqual(db.getTranscriptions(), []);
  assert.deepEqual(db.getAgentConversations(), []);

  await invoke("db-upsert-dictionary-from-cloud", word, tokenState.generation);
  assert.deepEqual(db.getDictionary(), ["Kubernetes"], "the current sign-in's row is written");
});

test("a chat ack is recorded for the account that sent it", async (t) => {
  const db = setup(t);
  if (!db) return;
  const chat = db.createAgentConversation("Started signed out");
  const current = db.getAgentConversation(chat.id);
  const snapshot = {
    client_conversation_id: current.client_conversation_id,
    title: current.title,
    updated_at: current.updated_at,
    message_count: 0,
  };
  db.setActiveAccountId("account-b");

  const ack = await invoke(
    "db-acknowledge-conversation-create",
    chat.id,
    snapshot,
    "c-1",
    "account-a"
  );
  assert.equal(ack.outcome, "synced");
  const row = db.db
    .prepare("SELECT account_id, cloud_id FROM agent_conversations WHERE id = ?")
    .get(chat.id);
  assert.deepEqual({ ...row }, { account_id: "account-a", cloud_id: "c-1" });
  assert.deepEqual(db.getAgentConversations(), [], "the active account doesn't get A's chat");
});

test("a recording is deleted only for a dictation the active account can see", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const { id } = db.saveTranscription("A dictated this", null, { clientTranscriptionId: "a-t" });
  db.setActiveAccountId("account-b");

  assert.equal((await invoke("delete-transcription-audio", id)).success, false);
  const CliBridge = require("../../src/helpers/cliBridge.js");
  assert.throws(
    () => call(new CliBridge(target), "DELETE", `/v1/transcriptions/${id}/audio`),
    /not found/
  );
  assert.deepEqual(deletedAudio, [], "B can't delete A's recording");

  db.setActiveAccountId("account-a");
  assert.equal((await invoke("delete-transcription-audio", id)).success, true);
  assert.deepEqual(deletedAudio, [id]);
});

test("an account change sends every window the new account's dictionary and snippets, once", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  db.applyDictionaryChanges({ add: ["Kubernetes"] });
  db.setSnippets([{ trigger: "addr", replacement: "A's address" }]);
  db.setActiveAccountId(null);
  const scopedLists = () =>
    broadcasts.filter(
      ([channel]) => channel === "dictionary-updated" || channel === "snippets-updated"
    );

  const scope = await invoke("set-active-account-scope", "account-a", tokenState.generation);
  assert.equal(scope.success, true);
  assert.deepEqual(scopedLists(), [
    ["dictionary-updated", ["Kubernetes"]],
    ["snippets-updated", [{ trigger: "addr", replacement: "A's address" }]],
  ]);

  await invoke("set-active-account-scope", "account-a", tokenState.generation);
  assert.equal(scopedLists().length, 2, "the same account again sends nothing");

  tokenState = { token: null, generation: tokenState.generation + 1 };
  handleAuthTokenChange(tokenState);
  assert.deepEqual(scopedLists().slice(2), [
    ["dictionary-updated", []],
    ["snippets-updated", []],
  ]);
});

test("the seed IPCs write a cached list only into a database that has never held one", async (t) => {
  const db = setup(t);
  if (!db) return;
  await assert.rejects(invoke("db-seed-dictionary", "Kubernetes"), /array/);
  await assert.rejects(invoke("db-seed-snippets", {}), /array/);

  assert.equal((await invoke("db-seed-dictionary", ["Kubernetes"])).seeded, true);
  assert.equal(
    (await invoke("db-seed-snippets", [{ trigger: "addr", replacement: "A's address" }])).seeded,
    true
  );
  assert.equal((await invoke("db-seed-dictionary", ["Terraform"])).seeded, false);
  assert.equal(
    (await invoke("db-seed-snippets", [{ trigger: "sig", replacement: "A" }])).seeded,
    false
  );
  assert.deepEqual(db.getDictionary(), ["Kubernetes"]);
});
