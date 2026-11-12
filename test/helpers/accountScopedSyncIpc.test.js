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
  shell: { showItemInFolder: (filePath) => revealedAudio.push(filePath) },
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
const readAudio = [];
const revealedAudio = [];
const audioStorageStub = {
  getAudioPath: (id) => {
    readAudio.push(id);
    return `audio-${id}.webm`;
  },
  getAudioBuffer: (id) => {
    readAudio.push(id);
    return Buffer.from("recording");
  },
  deleteAudio: (id) => {
    deletedAudio.push(id);
    return { success: true };
  },
};
const target = {
  sessionId: "test-session",
  databaseManager: null,
  audioStorageManager: audioStorageStub,
};
let handleAuthTokenChange;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target._broadcastAccountScopedSettings = Ctor.prototype._broadcastAccountScopedSettings;
  target._broadcastDatabaseAccountScope = Ctor.prototype._broadcastDatabaseAccountScope;
  target._claimSignedOutPrivateNotes = Ctor.prototype._claimSignedOutPrivateNotes;
  target.createFolderWithEffects = Ctor.prototype.createFolderWithEffects;
  target._noteFilesEnabled = false;
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
  target.audioStorageManager = audioStorageStub;
  tokenState = { token: "token-a", generation: 3 };
  broadcasts.length = 0;
  deletedAudio.length = 0;
  readAudio.length = 0;
  revealedAudio.length = 0;
  return db;
}

const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);

test("a queued transcription addition is broadcast only while its account can see it", async (t) => {
  const db = setup(t);
  if (!db) return;
  // A second account has signed in here, so signing out hides A's history.
  db.setActiveAccountId("account-b");
  db.setActiveAccountId("account-a");
  const current = await invoke("db-save-transcription", "A's current dictation");
  await new Promise(setImmediate);
  assert.deepEqual(
    broadcasts.filter(([channel]) => channel === "transcription-added"),
    [["transcription-added", current.transcription]]
  );

  broadcasts.length = 0;
  await invoke("db-save-transcription", "A's delayed dictation");
  tokenState = { token: null, generation: tokenState.generation + 1 };
  handleAuthTokenChange(tokenState);
  await new Promise(setImmediate);
  assert.deepEqual(
    broadcasts.filter(([channel]) => channel === "transcription-added"),
    [],
    "the queued addition cannot restore A's private history after sign-out"
  );
});

test("on a device only one account has used, its queued addition is still broadcast after sign-out", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const saved = await invoke("db-save-transcription", "A's delayed dictation");
  tokenState = { token: null, generation: tokenState.generation + 1 };
  handleAuthTokenChange(tokenState);
  await new Promise(setImmediate);
  assert.deepEqual(
    broadcasts.filter(([channel]) => channel === "transcription-added"),
    [["transcription-added", saved.transcription]]
  );
});

test("a push ack or pulled row from a replaced sign-in is refused", async (t) => {
  const db = setup(t);
  if (!db) return;
  assert.equal(
    (await invoke("set-active-account-scope", "account-a", tokenState.generation)).success,
    true
  );
  const stale = 2;
  const word = { id: "dict-1", word: "Kubernetes", client_dict_id: "a-dict" };
  const snippet = db.upsertSnippetFromCloud({
    id: "a-snippet",
    client_snippet_id: "a-snippet-client",
    trigger: "addr",
    replacement: "A's address",
  });

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
      null,
      stale
    ),
    await invoke(
      "db-claim-conversation-from-cloud",
      { id: "c-1", client_conversation_id: "a-chat" },
      stale
    ),
    await invoke("db-mark-transcription-synced", 1, "t-1", stale),
    await invoke("db-mark-dictionary-synced", 1, "dict-1", null, null, null, null, null, stale),
    await invoke("db-mark-snippet-synced", 1, "snip-1", null, null, null, stale),
    await invoke("db-get-snippet-for-cloud-merge", { trigger: "addr" }, stale),
    await invoke("db-hard-delete-snippet", snippet.id, stale),
    await invoke("db-hard-delete-conversation", 1, stale),
    await invoke("db-hard-delete-transcription", 1, stale),
    await invoke("db-hard-delete-dictionary", 1, stale),
    await invoke("db-clear-dictionary-cloud-id", 1, stale),
    await invoke("db-clear-snippet-cloud-id", snippet.id, stale),
    await invoke("db-clear-dictionary-cloud-id", 1),
    await invoke("db-clear-snippet-cloud-id", snippet.id),
  ];
  for (const result of refused) assert.equal(result?.stale, true);
  assert.equal(
    db.db.prepare("SELECT cloud_id FROM snippets WHERE id = ?").get(snippet.id).cloud_id,
    "a-snippet"
  );
  assert.deepEqual(db.getDictionary(), []);
  assert.deepEqual(db.getSnippets(), [{ trigger: "addr", replacement: "A's address" }]);
  assert.deepEqual(db.getTranscriptions(), []);
  assert.deepEqual(db.getAgentConversations(), []);

  await invoke("db-upsert-dictionary-from-cloud", word, tokenState.generation);
  assert.deepEqual(db.getDictionary(), ["Kubernetes"], "the current sign-in's row is written");
  assert.deepEqual(await invoke("db-clear-snippet-cloud-id", snippet.id, tokenState.generation), {
    success: true,
  });
});

test("a sync write is refused once its sign-in's scope has dropped, token unchanged", async (t) => {
  const db = setup(t);
  if (!db) return;
  const signIn = tokenState.generation;
  assert.equal((await invoke("set-active-account-scope", "account-a", signIn)).success, true);
  const pending = db.saveTranscription("A's pending dictation");

  // The session is revoked server-side: the same token now resolves to no
  // user, and the renderer drops the scope while A's pull is still writing.
  assert.equal((await invoke("set-active-account-scope", null, signIn)).success, true);
  assert.equal(db.activeAccountId, null);

  const late = [
    await invoke(
      "db-upsert-transcription-from-cloud",
      { id: "t-1", client_transcription_id: "a-t", text: "A's dictation" },
      signIn
    ),
    await invoke(
      "db-upsert-dictionary-from-cloud",
      { id: "w-1", word: "Kubernetes", client_dict_id: "a-w" },
      signIn
    ),
    await invoke(
      "db-upsert-snippet-from-cloud",
      { id: "s-1", client_snippet_id: "a-s", trigger: "addr", replacement: "A's address" },
      signIn
    ),
    await invoke(
      "db-upsert-conversation-from-cloud",
      { id: "c-1", client_conversation_id: "a-c", title: "A's chat" },
      [{ role: "user", content: "A's message" }],
      null,
      signIn
    ),
    await invoke("db-mark-transcription-synced", pending.id, "t-2", signIn),
  ];
  for (const result of late) assert.equal(result?.stale, true);
  const stored = (table) => db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  assert.deepEqual(
    ["custom_dictionary", "snippets", "agent_conversations"].map(stored),
    [0, 0, 0],
    "nothing A's cloud returned is stored without an owner"
  );
  assert.deepEqual(
    { ...db.db.prepare("SELECT text, cloud_id, sync_status FROM transcriptions").get() },
    { text: "A's pending dictation", cloud_id: null, sync_status: "pending" }
  );

  // Scoped again under the same token, its writes are accepted.
  assert.equal((await invoke("set-active-account-scope", "account-a", signIn)).success, true);
  await invoke(
    "db-upsert-dictionary-from-cloud",
    { id: "w-1", word: "Kubernetes", client_dict_id: "a-w" },
    signIn
  );
  assert.deepEqual(db.getDictionary(), ["Kubernetes"]);
});

test("a chat ack is recorded for the account its sign-in was scoped to, and no other", async (t) => {
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
  const signIn = tokenState.generation;
  assert.equal((await invoke("set-active-account-scope", "account-a", signIn)).success, true);
  // B signs in while A's create is in flight.
  db.setActiveAccountId("account-b");

  const ack = (accountId, generation) =>
    invoke("db-acknowledge-conversation-create", chat.id, snapshot, "c-1", accountId, generation);
  assert.equal((await ack("account-c", signIn)).success, false, "not an account it never was");
  assert.equal((await ack("account-a", signIn - 1)).success, false, "not for another sign-in");
  const markSynced = (accountId, generation) =>
    invoke("db-mark-conversation-synced", chat.id, "c-1", null, null, accountId, generation);
  const replaceClientId = (accountId, generation) =>
    invoke(
      "db-replace-conversation-client-id",
      chat.id,
      snapshot.client_conversation_id,
      accountId,
      generation
    );
  assert.equal((await markSynced("account-c", signIn)).success, false);
  assert.equal((await replaceClientId("account-c", signIn)).success, false);
  assert.equal((await replaceClientId("account-a", signIn - 1)).success, false);
  assert.deepEqual(
    {
      ...db.db.prepare("SELECT account_id, client_conversation_id FROM agent_conversations").get(),
    },
    { account_id: null, client_conversation_id: snapshot.client_conversation_id }
  );

  assert.equal((await ack("account-a", signIn)).outcome, "synced");
  const row = db.db
    .prepare("SELECT account_id, cloud_id FROM agent_conversations WHERE id = ?")
    .get(chat.id);
  assert.deepEqual({ ...row }, { account_id: "account-a", cloud_id: "c-1" });
  assert.deepEqual(db.getAgentConversations(), [], "the active account doesn't get A's chat");

  // The follow-up that sends what the create lacked settles for A as well.
  db.db.prepare("UPDATE agent_conversations SET sync_status = 'pending'").run();
  const settled = await invoke(
    "db-mark-conversation-synced",
    chat.id,
    "c-1",
    snapshot,
    "2026-10-20T12:00:00.000Z",
    "account-a",
    signIn
  );
  assert.equal(settled.success, true);
  assert.deepEqual(
    {
      ...db.db
        .prepare("SELECT sync_status, updated_at FROM agent_conversations WHERE id = ?")
        .get(chat.id),
    },
    { sync_status: "synced", updated_at: "2026-10-20T12:00:00.000Z" }
  );
});

test("a create answered with a tombstone re-keys the chat for its sender only", async (t) => {
  const db = setup(t);
  if (!db) return;
  const signIn = tokenState.generation;
  assert.equal((await invoke("set-active-account-scope", "account-a", signIn)).success, true);
  const chat = db.createAgentConversation("A's chat");
  const clientId = chat.client_conversation_id;
  db.markConversationCreateAttempted(chat.id);
  // B signs in while A's create is in flight.
  db.setActiveAccountId("account-b");

  const replaced = await invoke(
    "db-replace-conversation-client-id",
    chat.id,
    clientId,
    "account-a",
    signIn
  );
  assert.equal(replaced.success, true);
  const row = db.db
    .prepare(
      "SELECT account_id, client_conversation_id, cloud_create_attempted FROM agent_conversations"
    )
    .get();
  assert.equal(row.account_id, "account-a");
  assert.notEqual(row.client_conversation_id, clientId);
  assert.equal(row.cloud_create_attempted, 0);
});

test("a fork or a saved-message edit reaches only the active account's chats", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const chat = db.createAgentConversation("A's chat");
  const message = db.addAgentMessage(chat.id, "user", "A's question");
  db.setActiveAccountId("account-b");

  assert.equal(await invoke("db-fork-agent-conversation", chat.id, message.id, null), null);
  assert.equal(await invoke("db-update-agent-message", message.id, "B's text", null), null);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM agent_conversations").get().n,
    1,
    "no copy of A's chat was made"
  );
  assert.equal(
    db.db.prepare("SELECT content FROM agent_messages WHERE id = ?").get(message.id).content,
    "A's question"
  );
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

test("another account cannot read, reveal, or retry a cached history recording", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const { id } = db.saveTranscription("A dictated this");
  db.setActiveAccountId("account-b");

  assert.equal(await invoke("get-audio-path", id), null);
  assert.equal(await invoke("get-audio-buffer", id), null);
  assert.equal((await invoke("show-audio-in-folder", id)).success, false);
  assert.equal((await invoke("retry-transcription", id, {})).success, false);
  assert.deepEqual(readAudio, [], "the other account never reaches the recording");
  assert.deepEqual(revealedAudio, []);

  db.setActiveAccountId("account-a");
  assert.equal(await invoke("get-audio-path", id), `audio-${id}.webm`);
  assert.ok((await invoke("get-audio-buffer", id)) instanceof ArrayBuffer);
  assert.equal((await invoke("show-audio-in-folder", id)).success, true);
  assert.deepEqual(revealedAudio, [`audio-${id}.webm`]);
});

test("a sync write that names no sign-in is refused like a stale one", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const { id } = db.saveTranscription("A dictated this");

  for (const [channel, ...args] of [
    ["db-upsert-dictionary-from-cloud", { id: "d", word: "Word", client_dict_id: "d" }],
    ["db-upsert-conversation-from-cloud", { id: "c", client_conversation_id: "c" }, [], null],
    ["db-claim-conversation-from-cloud", { id: "c", client_conversation_id: "c" }],
    ["db-mark-transcription-synced", id, "cloud"],
    ["db-mark-dictionary-synced", 1, "cloud"],
    ["db-hard-delete-transcription", id],
    ["db-hard-delete-conversation", 1],
    ["db-hard-delete-dictionary", 1],
    ["db-hard-delete-snippet", 1],
  ]) {
    assert.equal((await invoke(channel, ...args))?.stale, true, channel);
  }
  assert.ok(db.getTranscriptionById(id));
  assert.deepEqual(db.getDictionary(), []);
});

test("the shared dictionary's writes and a whole-list save are refused for a replaced sign-in", async (t) => {
  const db = setup(t);
  if (!db) return;
  await invoke("set-active-account-scope", "account-a", tokenState.generation);
  db.applyDictionaryChanges({ add: ["Word"] });
  db.setSnippets([{ trigger: "addr", replacement: "home" }]);
  const stale = tokenState.generation - 1;
  const current = tokenState.generation;

  const at = "2026-10-20T12:00:00.000Z";
  assert.equal((await invoke("db-mark-dictionary-words-shared", ["Word"], at, {}))?.stale, true);
  assert.equal(
    (
      await invoke("db-mark-dictionary-words-shared", ["Word"], at, {
        expectedAuthGeneration: stale,
      })
    )?.stale,
    true
  );
  assert.deepEqual(db.getMovedDictionaryWords(), []);
  await invoke("db-mark-dictionary-words-shared", ["Word"], at, {
    expectedAuthGeneration: current,
  });
  assert.deepEqual(db.getMovedDictionaryWords(), ["Word"]);

  const retire = { expectedAuthGeneration: stale };
  assert.equal((await invoke("db-retire-moved-dictionary-words", ["Word"], retire))?.stale, true);
  assert.deepEqual(db.getDictionary(), ["Word"]);
  retire.expectedAuthGeneration = current;
  await invoke("db-retire-moved-dictionary-words", ["Word"], retire);
  assert.deepEqual(db.getDictionary(), []);
  assert.equal(
    (
      await invoke("db-revive-retired-dictionary-words", ["Word"], {
        expectedAuthGeneration: stale,
      })
    )?.stale,
    true
  );
  assert.deepEqual(db.getDictionary(), []);
  await invoke("db-revive-retired-dictionary-words", ["Word"], { expectedAuthGeneration: current });
  assert.deepEqual(db.getDictionary(), ["Word"]);

  // A window still showing another account's lists can't save them over this one's.
  assert.equal((await invoke("db-set-dictionary", ["Stale"], "account-b"))?.stale, true);
  assert.equal((await invoke("db-set-snippets", [], "account-b"))?.stale, true);
  assert.deepEqual(db.getDictionary(), ["Word"]);
  assert.equal(db.getSnippets().length, 1);
  await invoke("db-set-dictionary", ["Fresh"], "account-a");
  assert.deepEqual(db.getDictionary(), ["Fresh"]);
});

test("another account can't edit a dictation's text", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const { id } = db.saveTranscription("A dictated this");
  db.setActiveAccountId("account-b");
  assert.equal((await invoke("update-transcription-text", id, "B wrote this")).success, false);
  db.setActiveAccountId("account-a");
  assert.equal(db.getTranscriptionById(id).text, "A dictated this");
  assert.equal((await invoke("update-transcription-text", id, "A edited this")).success, true);
  assert.equal(db.getTranscriptionById(id).text, "A edited this");
});

test("deleting all audio and its storage count leave another account's recordings out", async (t) => {
  const db = setup(t);
  if (!db) return;
  const AudioStorageManager = require("../../src/helpers/audioStorage");
  const audio = new AudioStorageManager();
  target.audioStorageManager = audio;
  const record = (accountId, text) => {
    db.setActiveAccountId(accountId);
    const { id } = db.saveTranscription(text);
    const { path: filePath } = audio.saveAudio(id, Buffer.from(text));
    db.updateTranscriptionAudio(id, { hasAudio: 1 });
    return { id, filePath };
  };
  const a = record("account-a", "A's recording");
  const b = record("account-b", "B's recording");
  const orphan = audio.saveAudio(9999, Buffer.from("no row")).path;

  assert.equal((await invoke("get-audio-storage-usage")).fileCount, 2, "B's and the orphan");
  await invoke("delete-all-audio");
  assert.equal(fs.existsSync(a.filePath), true, "A's recording stays");
  assert.equal(fs.existsSync(b.filePath), false);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(db.getTranscriptionById(b.id).has_audio, 0);
  db.setActiveAccountId("account-a");
  assert.equal(db.getTranscriptionById(a.id).has_audio, 1);
  assert.equal((await invoke("get-audio-storage-usage")).fileCount, 1);
});

test("a scoped cloud hard-delete removes the row and its recording", async (t) => {
  const db = setup(t);
  if (!db) return;
  const AudioStorageManager = require("../../src/helpers/audioStorage");
  const audio = new AudioStorageManager();
  target.audioStorageManager = audio;
  db.setActiveAccountId("account-a");
  const { id: aId } = db.saveTranscription("A's recording");
  const aPath = audio.saveAudio(aId, Buffer.from("A's recording")).path;
  db.setActiveAccountId("account-b");
  const { id: bId } = db.saveTranscription("B's recording");
  const bPath = audio.saveAudio(bId, Buffer.from("B's recording")).path;

  const signIn = tokenState.generation;
  await invoke("set-active-account-scope", "account-b", signIn);
  assert.deepEqual(await invoke("db-hard-delete-transcription", aId, signIn), {
    success: false,
    id: aId,
  });
  assert.equal(fs.existsSync(aPath), true, "another account's deletion is refused");
  await invoke("set-active-account-scope", "account-a", signIn);
  assert.equal((await invoke("db-hard-delete-transcription", aId, signIn)).success, true);
  assert.equal(db.getTranscriptionById(aId), null);
  assert.equal(fs.existsSync(aPath), false, "the remote deletion leaves no orphaned recording");
  assert.equal(fs.existsSync(bPath), true, "the other account's recording stays");
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
  db.setActiveAccountId(null);
  const guestChat = db.createAgentConversation("container chat", null, 1);
  await invoke("set-active-account-scope", "account-a", tokenState.generation);
  assert.equal(
    db.getAgentConversation(guestChat.id)?.account_id,
    "account-a",
    "signing in takes the signed-out chats that never sync"
  );
  broadcasts.length = 0;

  // Nobody else has signed in on this device, so A's lists stay in use.
  tokenState = { token: null, generation: tokenState.generation + 1 };
  handleAuthTokenChange(tokenState);
  assert.deepEqual(scopedLists(), [
    ["dictionary-updated", ["Kubernetes"]],
    ["snippets-updated", [{ trigger: "addr", replacement: "A's address" }]],
  ]);
});

test("signing out of a device two accounts have used sends every window empty lists", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-b");
  db.setActiveAccountId("account-a");
  db.applyDictionaryChanges({ add: ["Kubernetes"] });
  db.setSnippets([{ trigger: "addr", replacement: "A's address" }]);

  tokenState = { token: null, generation: tokenState.generation + 1 };
  handleAuthTokenChange(tokenState);
  assert.deepEqual(
    broadcasts.filter(
      ([channel]) => channel === "dictionary-updated" || channel === "snippets-updated"
    ),
    [
      ["dictionary-updated", []],
      ["snippets-updated", []],
    ]
  );
});

test("between a token rotation and the re-scope, the database scope keeps the account and its saves go through", async (t) => {
  const db = setup(t);
  if (!db) return;
  assert.equal(
    (await invoke("set-active-account-scope", "account-a", tokenState.generation)).success,
    true
  );
  db.setSnippets([{ trigger: "addr", replacement: "A's address" }]);
  broadcasts.length = 0;

  // The bearer rotates for the same account; the renderer hasn't re-scoped yet.
  tokenState = { token: "token-a-rotated", generation: tokenState.generation + 1 };
  handleAuthTokenChange(tokenState);
  assert.equal(await invoke("get-active-account-scope"), null, "the binding no longer matches");
  const scope = await invoke("get-database-account-scope");
  assert.deepEqual(scope, { accountId: "account-a", visibleAccountId: "account-a" });

  const sig = { trigger: "sig", replacement: "Best, A" };
  const saved = await invoke(
    "db-set-snippets",
    [{ trigger: "addr", replacement: "A's address" }, sig],
    scope.accountId
  );
  assert.equal(saved.success, true);
  assert.deepEqual(
    db.getSnippets().map((row) => row.trigger),
    ["addr", "sig"]
  );

  await invoke("set-active-account-scope", "account-a", tokenState.generation);
  assert.deepEqual(
    broadcasts.filter(([channel]) => channel === "database-account-scope-changed"),
    [["database-account-scope-changed", { accountId: "account-a", visibleAccountId: "account-a" }]]
  );
});

test("signing out sends the database scope: a sole account stays in view, a shared device shows none", async (t) => {
  const db = setup(t);
  if (!db) return;
  const signIn = async (accountId) => {
    tokenState = { token: `token-${accountId}`, generation: tokenState.generation + 1 };
    await invoke("set-active-account-scope", accountId, tokenState.generation);
  };
  const signOut = () => {
    tokenState = { token: null, generation: tokenState.generation + 1 };
    handleAuthTokenChange(tokenState);
  };
  const lastScope = () =>
    broadcasts.filter(([channel]) => channel === "database-account-scope-changed").at(-1)?.[1];

  await signIn("account-a");
  signOut();
  assert.deepEqual(lastScope(), { accountId: null, visibleAccountId: "account-a" });
  assert.deepEqual(await invoke("get-database-account-scope"), lastScope());

  await signIn("account-b");
  signOut();
  assert.deepEqual(lastScope(), { accountId: null, visibleAccountId: null });
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

test("audio retention expires a recording whoever owns it, signed out too", async (t) => {
  const db = setup(t);
  if (!db) return;
  const AudioStorageManager = require("../../src/helpers/audioStorage");
  const audio = new AudioStorageManager();
  const record = (accountId, text, ageDays) => {
    db.setActiveAccountId(accountId);
    const { id } = db.saveTranscription(text);
    const { path: filePath } = audio.saveAudio(id, Buffer.from(text));
    const modified = new Date(Date.now() - ageDays * 86400000);
    fs.utimesSync(filePath, modified, modified);
    db.updateTranscriptionAudio(id, { hasAudio: 1 });
    return { id, filePath };
  };
  const expiredA = record("account-a", "A's old recording", 90);
  const expiredB = record("account-b", "B's old recording", 90);
  const freshB = record("account-b", "B's new recording", 1);

  db.setActiveAccountId(null);
  assert.equal(audio.cleanupExpiredAudio(30, db).deleted, 2);

  assert.equal(fs.existsSync(expiredA.filePath), false, "signed out, A's expired file goes");
  assert.equal(fs.existsSync(expiredB.filePath), false, "signed out, B's expired file goes");
  assert.equal(fs.existsSync(freshB.filePath), true, "a recording inside the period stays");
  db.setActiveAccountId("account-a");
  assert.equal(db.getTranscriptionById(expiredA.id).has_audio, 0);
  db.setActiveAccountId("account-b");
  assert.equal(db.getTranscriptionById(expiredB.id).has_audio, 0);
  assert.equal(db.getTranscriptionById(freshB.id).has_audio, 1);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a dictation in flight across a switch belongs to whoever spoke it", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  await tick();
  const spokenAt = new Date().toISOString();
  await tick();
  db.setActiveAccountId("account-b");

  const saved = await invoke("db-save-transcription", "A's late dictation", null, {
    clientTranscriptionId: "late",
    analyticsOccurredAt: spokenAt,
  });
  db.recordAnalyticsEvent({
    eventId: "late",
    wordCount: 3,
    occurredAt: spokenAt,
    localDate: spokenAt.slice(0, 10),
  });
  await new Promise(setImmediate);

  const owner = (table, where) =>
    db.db.prepare(`SELECT account_id FROM ${table} WHERE ${where}`).get().account_id;
  assert.equal(owner("transcriptions", `id = ${saved.id}`), "account-a");
  assert.equal(owner("analytics_events", "event_id = 'late'"), "account-a");
  assert.equal(db.getTranscriptionById(saved.id), null, "B can't see or push it");
  assert.deepEqual(
    broadcasts.filter(([channel]) => channel === "transcription-added"),
    [],
    "B's open history isn't told about it"
  );
  db.setActiveAccountId("account-a");
  assert.equal(db.getTranscriptionById(saved.id).text, "A's late dictation");
});

test("a dictation spoken signed out stays unattributed if an account arrives first", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId(null);
  await tick();
  const spokenAt = new Date().toISOString();
  await tick();
  db.setActiveAccountId("account-a");

  const saved = await invoke("db-save-transcription", "guest dictation", null, {
    analyticsOccurredAt: spokenAt,
  });

  assert.equal(saved.transcription.account_id, null);
  assert.equal(db.getTranscriptionById(saved.id).text, "guest dictation", "A can still see it");
  await new Promise(setImmediate);
});

test("a dictation with no spoken time, or spoken after the switch, is the active account's", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  await tick();
  db.setActiveAccountId("account-b");
  await tick();

  const noTime = await invoke("db-save-transcription", "no time");
  const after = await invoke("db-save-transcription", "after the switch", null, {
    analyticsOccurredAt: new Date().toISOString(),
  });

  assert.equal(noTime.transcription.account_id, "account-b");
  assert.equal(after.transcription.account_id, "account-b");
  await new Promise(setImmediate);
});

test("main reports whether the account changed since a recording started", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  await tick();
  const startedBeforeSwitch = new Date().toISOString();
  await tick();

  db.setActiveAccountId("account-a");
  assert.equal(
    await invoke("db-account-changed-since", startedBeforeSwitch),
    false,
    "re-scoping the same account after a token rotation isn't a change"
  );
  db.setActiveAccountId("account-b");
  assert.equal(await invoke("db-account-changed-since", startedBeforeSwitch), true);
  await tick();
  assert.equal(await invoke("db-account-changed-since", new Date().toISOString()), false);
  assert.equal(await invoke("db-account-changed-since", undefined), false);
  db.setActiveAccountId(null);
  assert.equal(
    await invoke("db-account-changed-since", startedBeforeSwitch),
    true,
    "signing out left the account the recording was spoken under"
  );
});

test("a guest who signs in mid-recording, or a scope restored late, changed no account", async (t) => {
  const db = setup(t);
  if (!db) return;
  await tick();
  const startedSignedOut = new Date().toISOString();
  await tick();
  db.setActiveAccountId("account-a");

  assert.equal(await invoke("db-account-changed-since", startedSignedOut), false);
});

test("signing in on a device nobody else used claims the rows from before attribution", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId(null);
  const { id } = db.saveTranscription("from before the upgrade");
  db.db.prepare("UPDATE transcriptions SET legacy_unattributed = 1").run();

  const result = await invoke("set-active-account-scope", "account-a", tokenState.generation);

  assert.equal(result.success, true);
  assert.equal(
    db.db.prepare("SELECT account_id FROM transcriptions WHERE id = ?").get(id).account_id,
    "account-a"
  );
});

test("a queued dictionary delta from another account is refused", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  db.applyDictionaryChanges({ add: ["SharedProduct", "A's word"] });
  db.setActiveAccountId("account-b");
  db.applyDictionaryChanges({ add: ["SharedProduct", "B's word"] });

  const result = await invoke(
    "db-apply-dictionary-changes",
    { remove: ["SharedProduct"], add: ["A's renamed word"] },
    "account-a"
  );

  assert.equal(result.stale, true);
  assert.deepEqual(db.getDictionary().sort(), ["B's word", "SharedProduct"]);
  db.setActiveAccountId("account-a");
  assert.deepEqual(db.getDictionary().sort(), ["A's word", "SharedProduct"]);
});

test("dictionary deltas remain editable signed out and across a same-account token rotation", async (t) => {
  const db = setup(t);
  if (!db) return;
  await invoke("set-active-account-scope", "account-a", tokenState.generation);
  db.applyDictionaryChanges({ add: ["Original"] });
  tokenState = { token: "token-a-rotated", generation: tokenState.generation + 1 };
  handleAuthTokenChange(tokenState);

  assert.equal(
    (await invoke("db-apply-dictionary-changes", { add: ["Rotated"] }, "account-a")).success,
    true
  );
  tokenState = { token: null, generation: tokenState.generation + 1 };
  handleAuthTokenChange(tokenState);
  assert.equal(
    (await invoke("db-apply-dictionary-changes", { remove: ["Original"] }, null)).success,
    true
  );
  assert.deepEqual(db.getDictionary(), ["Rotated"]);
});

test("signing in gives the account its signed-out notes, after the chats the sign-in claims", async (t) => {
  const db = setup(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const note = db.saveNote("Written signed out", "").note;
  const chat = db.createAgentConversation("Signed-out chat", null, standInId);
  assert.equal(chat.account_id, null);

  assert.equal(
    (await invoke("set-active-account-scope", "account-a", tokenState.generation)).success,
    true
  );

  const home = db.getDefaultPrivateSpaceId();
  assert.notEqual(home, standInId);
  assert.deepEqual(
    { ...db.db.prepare("SELECT space_id, account_id FROM notes WHERE id = ?").get(note.id) },
    { space_id: home, account_id: "account-a" }
  );
  assert.deepEqual(
    {
      ...db.db
        .prepare("SELECT space_id, folder_id, account_id FROM agent_conversations WHERE id = ?")
        .get(chat.id),
    },
    { space_id: home, folder_id: null, account_id: "account-a" },
    "the chat #2924 attributed at sign-in left the stand-in with the notes"
  );
});

test("the private-space IPCs check their arguments and the account they were sent for", async (t) => {
  const db = setup(t);
  if (!db) return;
  await invoke("set-active-account-scope", "account-a", tokenState.generation);

  for (const scope of [null, "w1", ["w1"], { activeWorkspaceId: 3 }, { defaultWorkspaceId: "" }]) {
    assert.equal((await invoke("set-active-workspace-scope", scope)).success, false);
  }
  assert.equal(
    (
      await invoke("set-active-workspace-scope", {
        activeWorkspaceId: "w2",
        defaultWorkspaceId: "w1",
        accountId: "account-b",
      })
    ).code,
    "ACCOUNT_CHANGED"
  );
  assert.equal(db.activeWorkspaceId, null, "a refused scope changes nothing");
  assert.deepEqual(
    await invoke("set-active-workspace-scope", {
      activeWorkspaceId: "w2",
      defaultWorkspaceId: "w1",
      accountId: "account-a",
    }),
    { success: true }
  );

  const w2 = await invoke("get-private-space-id");
  assert.deepEqual(
    { ...db.db.prepare("SELECT account_id, workspace_id FROM spaces WHERE id = ?").get(w2) },
    { account_id: "account-a", workspace_id: "w2" }
  );
  assert.equal(await invoke("get-private-space-id", "w2"), w2);
  assert.equal(await invoke("get-private-space-id", 7), null);
  assert.equal(await invoke("get-private-space-id", ""), null);

  const pending = db.getDefaultPrivateSpaceId();
  for (const id of [undefined, null, "", 42]) {
    assert.equal((await invoke("bind-default-private-space", id)).success, false);
  }
  assert.equal(
    (await invoke("bind-default-private-space", "w1", "account-b")).code,
    "ACCOUNT_CHANGED"
  );
  assert.equal(
    db.db.prepare("SELECT workspace_id FROM spaces WHERE id = ?").get(pending).workspace_id,
    null
  );
  assert.deepEqual(await invoke("bind-default-private-space", "w1", "account-a"), {
    success: true,
  });
  assert.equal(
    db.db.prepare("SELECT workspace_id FROM spaces WHERE id = ?").get(pending).workspace_id,
    "w1"
  );

  await invoke("set-active-account-scope", null, tokenState.generation);
  assert.equal((await invoke("bind-default-private-space", "w1")).code, "SIGNED_OUT");
  assert.equal(await invoke("get-private-space-id", "w2"), db._standInPrivateSpaceId());
});

test("copy-note-to-space copies a note into the account's Private and announces it", async (t) => {
  const db = setup(t);
  if (!db) return;
  await invoke("set-active-account-scope", "account-a", tokenState.generation);
  await invoke("set-active-workspace-scope", {
    activeWorkspaceId: "w1",
    defaultWorkspaceId: "w1",
    accountId: "account-a",
  });
  const home = db.getDefaultPrivateSpaceId();
  const team = db.db
    .prepare("INSERT INTO spaces (client_space_id, kind, name) VALUES ('ipc-team', 'team', 'Team')")
    .run().lastInsertRowid;
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, 'account-a')")
    .run(team);
  const source = db.saveNote("Team note", "body", "personal", null, null, null, team).note;
  db.markNoteSynced(source.id, "cloud-team-note");

  for (const args of [
    [],
    ["7", home],
    [source.id, "home"],
    [source.id, home, "folder"],
    [-1, home],
    [source.id, 1.5],
  ]) {
    assert.equal(await invoke("copy-note-to-space", ...args), null);
  }
  assert.equal(await invoke("copy-note-to-space", source.id, team), null);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 1);

  broadcasts.length = 0;
  const copy = await invoke("copy-note-to-space", source.id, home, null);
  await new Promise(setImmediate);

  assert.equal(copy.space_id, home);
  assert.equal(copy.account_id, "account-a");
  assert.equal(copy.cloud_id, null);
  assert.equal(db.getNote(source.id).cloud_id, "cloud-team-note");
  assert.deepEqual(
    broadcasts.filter(([channel]) => channel === "note-added"),
    [["note-added", copy]]
  );
});

test("relocate-private-space checks its arguments and the account it was sent for", async (t) => {
  const db = setup(t);
  if (!db) return;
  await invoke("set-active-account-scope", "account-a", tokenState.generation);
  await invoke("set-active-workspace-scope", {
    activeWorkspaceId: "w2",
    defaultWorkspaceId: "w1",
    accountId: "account-a",
  });
  await invoke("bind-default-private-space", "w1", "account-a");
  const home = db.getDefaultPrivateSpaceId();
  const note = db.saveNote("In w2", "").note;
  const w2 = note.space_id;
  assert.notEqual(w2, home);

  for (const args of [[], [null], [""], [42], ["w2", ""], ["w2", 7]]) {
    assert.equal((await invoke("relocate-private-space", ...args)).success, false);
  }
  assert.equal(
    (await invoke("relocate-private-space", "w2", null, "account-b")).code,
    "ACCOUNT_CHANGED"
  );
  assert.equal(db.getNote(note.id).space_id, w2, "a refused call moves nothing");

  assert.deepEqual(await invoke("relocate-private-space", "w2", null, "account-a"), {
    success: true,
    notes: 1,
    folders: 2,
  });
  assert.equal(db.getNote(note.id).space_id, home);
  assert.ok(
    broadcasts.some(([channel, space]) => channel === "space-synced" && space.id === home),
    "relocation announces final private scope"
  );
  assert.deepEqual(await invoke("relocate-private-space", "w2", null), {
    success: true,
    notes: 0,
    folders: 0,
  });

  await invoke("set-active-account-scope", null, tokenState.generation);
  assert.equal((await invoke("relocate-private-space", "w1", null)).code, "SIGNED_OUT");
});

test("conversation privacy IPC refuses stale accounts, foreign rows and malformed references", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("owner");
  const chat = db.createAgentConversation("Root");
  const note = db.saveNote("Private", "canary", "personal").note;
  for (const references of [null, {}, [null], [{ id: note.id }]]) {
    assert.deepEqual(await invoke("db-protect-conversation", chat.id, references, false, "owner"), {
      success: false,
    });
  }
  db.setActiveAccountId("other");
  assert.deepEqual(await invoke("db-protect-conversation", chat.id, [note], false, "owner"), {
    success: false,
  });
  assert.deepEqual(await invoke("db-protect-conversation", chat.id, [note], false, "other"), {
    success: false,
  });
  db.setActiveAccountId("owner");
  assert.deepEqual(await invoke("db-protect-conversation", chat.id, [note], false, "owner"), {
    success: true,
  });
  assert.equal(db.getAgentConversation(chat.id).device_only, 1);
});

for (const operation of ["create", "update"]) {
  for (const existingFolder of [false, true]) {
    test(`${operation}_note cannot write after cancellation/account switch while resolving ${existingFolder ? "existing" : "new"} folder`, async (t) => {
      const db = setup(t);
      if (!db) return;
      const { joinTeamSpace } = require("./harness/teamSpace");
      const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
      const team = joinTeamSpace(db, null, { accountId: "account-a" });
      const note = db.saveNote("Original", "original", "personal", null, null, null, team.id).note;
      if (existingFolder) db.createFolder("Target", team.id);
      const initialNotes = db.db.prepare("SELECT COUNT(*) AS count FROM notes").get().count;
      const initialFolders = db.db.prepare("SELECT COUNT(*) AS count FROM folders").get().count;
      let resume, started;
      const gate = new Promise((resolve) => {
        resume = resolve;
      });
      const waiting = new Promise((resolve) => {
        started = resolve;
      });
      installBrowserGlobals(t, {
        window: {
          electronAPI: {
            getNoteWriteGuard: async () => invoke("get-note-write-guard"),
            getSpaces: async () => db.getSpaces(),
            getNote: async (id) => db.getNote(id),
            getFolders: async (spaceId) => {
              const folders = db.getFolders(spaceId);
              started();
              await gate;
              return folders;
            },
            createFolder: async (...args) => invoke("db-create-folder", ...args),
            saveNote: async (...args) => invoke("db-save-note", ...args),
            updateNote: async (...args) => invoke("db-update-note", ...args),
          },
        },
      });
      const vite = await createRendererServer(t, {
        mockModules: { "/SyncService.js": "export const syncService = { debouncedPush() {} };" },
      });
      const module = await vite.ssrLoadModule(
        `/services/tools/${operation === "create" ? "createNoteTool" : "updateNoteTool"}.ts`
      );
      const tool = (
        operation === "create" ? module.createCreateNoteTool : module.createUpdateNoteTool
      )({ spaceIds: [team.id] });
      const { executeTool } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
      const controller = new AbortController();
      const execute = tool.execute;
      let underlying;
      tool.execute = (...args) => {
        underlying = execute(...args);
        return underlying;
      };
      const result = executeTool(
        tool,
        {
          id: note.id,
          title: "PRIVATE_ACCOUNT_CANARY",
          content: "PRIVATE_ACCOUNT_CANARY",
          space: team.name,
          folder: "Target",
        },
        { signal: controller.signal }
      );
      await waiting;
      controller.abort();
      joinTeamSpace(db, null, { accountId: "account-b" });
      resume();
      assert.equal((await result).success, false);
      await underlying;
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes").get().count, initialNotes);
      assert.equal(
        db.db.prepare("SELECT COUNT(*) AS count FROM folders").get().count,
        initialFolders
      );
      assert.equal(db.getNote(note.id).content, "original");
      assert.equal(
        db.db
          .prepare(
            "SELECT COUNT(*) AS count FROM notes WHERE content LIKE '%PRIVATE_ACCOUNT_CANARY%'"
          )
          .get().count,
        0
      );
    });
  }
}

for (const operation of ["create", "update"]) {
  for (const pauseAt of ["folder", "note"]) {
    for (const boundary of ["account", "generation"]) {
      test(`${operation}_note main rejects ${pauseAt} writes queued across ${boundary} changes`, async (t) => {
        const db = setup(t);
        if (!db) return;
        const { joinTeamSpace } = require("./harness/teamSpace");
        const {
          createRendererServer,
          installBrowserGlobals,
        } = require("../lib/rendererTestHarness");
        const team = joinTeamSpace(db, null, { accountId: "account-a" });
        const note = db.saveNote(
          "Original",
          "original",
          "personal",
          null,
          null,
          null,
          team.id
        ).note;
        const initialNotes = db.db.prepare("SELECT COUNT(*) AS count FROM notes").get().count;
        const initialFolders = db.db.prepare("SELECT COUNT(*) AS count FROM folders").get().count;
        const beforeWrite = async (kind, channel, args) => {
          if (kind === pauseAt) {
            if (boundary === "account") joinTeamSpace(db, null, { accountId: "account-b" });
            else tokenState = { ...tokenState, generation: tokenState.generation + 1 };
          }
          return invoke(channel, ...args);
        };
        installBrowserGlobals(t, {
          window: {
            electronAPI: {
              getNoteWriteGuard: async () => invoke("get-note-write-guard"),
              getSpaces: async () => db.getSpaces(),
              getNote: async (id) => db.getNote(id),
              getFolders: async (spaceId) => db.getFolders(spaceId),
              createFolder: async (...args) => beforeWrite("folder", "db-create-folder", args),
              saveNote: async (...args) => beforeWrite("note", "db-save-note", args),
              updateNote: async (...args) => beforeWrite("note", "db-update-note", args),
            },
          },
        });
        const vite = await createRendererServer(t, {
          mockModules: { "/SyncService.js": "export const syncService = { debouncedPush() {} };" },
        });
        const module = await vite.ssrLoadModule(
          `/services/tools/${operation === "create" ? "createNoteTool" : "updateNoteTool"}.ts`
        );
        const tool = (
          operation === "create" ? module.createCreateNoteTool : module.createUpdateNoteTool
        )({ spaceIds: [team.id] });
        const { executeTool } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
        const result = await executeTool(
          tool,
          {
            id: note.id,
            title: "PRIVATE_ACCOUNT_CANARY",
            content: "PRIVATE_ACCOUNT_CANARY",
            space: team.name,
            ...(pauseAt === "folder" ? { folder: "PRIVATE_FOLDER_CANARY" } : {}),
          },
          { signal: new AbortController().signal }
        );
        assert.equal(result.success, false);
        assert.equal(
          db.db.prepare("SELECT COUNT(*) AS count FROM notes").get().count,
          initialNotes
        );
        assert.equal(
          db.db.prepare("SELECT COUNT(*) AS count FROM folders").get().count,
          initialFolders
        );
        assert.equal(db.getNote(note.id).content, "original");
        assert.equal(
          db.db
            .prepare(
              "SELECT COUNT(*) AS count FROM notes WHERE content LIKE '%PRIVATE_ACCOUNT_CANARY%'"
            )
            .get().count,
          0
        );
      });
    }
  }
}

test("guarded note/folder writes accept the original signed-in and signed-out account only", async (t) => {
  const db = setup(t);
  if (!db) return;
  for (const accountId of ["owner", null]) {
    db.setActiveAccountId(accountId);
    const guard = await invoke("get-note-write-guard");
    assert.deepEqual(guard, { accountId, authGeneration: tokenState.generation });
    const spaceId = db.getPrivateSpaceId();
    const folder = await invoke("db-create-folder", "Guarded folder", spaceId, guard);
    assert.equal(folder.success, true);
    const saved = await invoke(
      "db-save-note",
      "Guarded note",
      "body",
      "personal",
      null,
      null,
      folder.folder.id,
      spaceId,
      null,
      guard
    );
    assert.equal(saved.success, true);
    assert.equal(
      (
        await invoke(
          "db-update-note",
          saved.note.id,
          { content: "updated" },
          { undoable: true, expected: saved.note, writeGuard: guard }
        )
      ).success,
      true
    );
    for (const malformed of [null, {}, { accountId }, { accountId, authGeneration: "3" }]) {
      assert.equal(
        (await invoke("db-create-folder", "Refused", spaceId, malformed)).success,
        false
      );
    }
  }
});

test("restored conversation privacy is account-bound and rejects late pulls after a switch", async (t) => {
  const db = setup(t);
  if (!db) return;
  await invoke("set-active-account-scope", "account-a", tokenState.generation);
  const cloud = {
    id: "restore-cloud-a",
    client_conversation_id: "restore-client-a",
    title: "A's restored history",
  };
  const restored = await invoke(
    "db-upsert-conversation-from-cloud",
    cloud,
    [{ role: "user", content: "A_PRIVATE_RESTORE" }],
    null,
    tokenState.generation
  );
  assert.equal(restored.device_only, 1);
  tokenState = { token: "token-b", generation: 4 };
  await invoke("set-active-account-scope", "account-b", tokenState.generation);
  const refused = await invoke(
    "db-upsert-conversation-from-cloud",
    { ...cloud, client_conversation_id: "late-a" },
    [{ role: "user", content: "A_PRIVATE_RESTORE" }],
    null,
    3
  );
  assert.equal(refused.stale, true);
  assert.equal(db.getAgentConversation(restored.id), null);
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE account_id = 'account-b'")
      .get().count,
    0
  );
});
