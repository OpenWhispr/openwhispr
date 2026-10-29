// A local tombstone must outlive a pull, a note or chat no create request has
// carried leaves the device when it is deleted, and delete pushes must never
// reach the cloud for rows that were never synced.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");

const LOCAL_EARLY = "2026-07-20 10:00:00";

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  const api = createElectronApi(db, { cloud });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, cloud, api, service };
}

function updateNote(db, id, fields) {
  const keys = Object.keys(fields);
  db.db
    .prepare(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  return db.getNote(id);
}

function silenceConsoleErrors(t) {
  t.mock.method(console, "error", () => {});
}

function attempted(db, table, id) {
  return db.db.prepare(`SELECT cloud_create_attempted AS flag FROM ${table} WHERE id = ?`).get(id)
    .flag;
}

function rowCount(db, table, id) {
  return db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id).n;
}

function batchCreatedClientIds(cloud) {
  return cloud
    .logFor("/api/notes/batch-create")
    .flatMap((call) => call.body.notes.map((row) => row.client_note_id));
}

// Runs act() once, right after the first sync read that returns the note.
function afterPendingRead(api, noteId, act) {
  const read = api.getPendingNotes;
  api.getPendingNotes = async (spaceKind) => {
    const pending = await read(spaceKind);
    if (pending.some((row) => row.id === noteId)) {
      api.getPendingNotes = read;
      act();
    }
    return pending;
  };
}

// Runs act() once, after the cloud answered the first matching request and
// before the sync pass sees the answer.
function afterCloudAnswers(api, matches, act) {
  const send = api.cloudApiRequest;
  api.cloudApiRequest = async (opts) => {
    const answer = await send(opts);
    if (matches(opts)) {
      api.cloudApiRequest = send;
      act();
    }
    return answer;
  };
}

// The database as a release without create attempts left it; reopening runs
// the upgrade.
function reopenWithoutCreateAttempts(db) {
  for (const table of ["notes", "agent_conversations"]) {
    db.db.exec(`ALTER TABLE ${table} DROP COLUMN cloud_create_attempted`);
  }
  db.db.close();
  db.initDatabase();
}

test("a local tombstone survives a pull serving a newer cloud copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  silenceConsoleErrors(t);

  const note = db.saveNote("Doomed", "body", "personal").note;
  const local = db.getNote(note.id);
  const cloudRow = cloud.seedNote({
    client_note_id: local.client_note_id,
    title: "Doomed",
    content: "body",
    updated_at: "2026-07-20T09:00:00.000Z",
  });
  updateNote(db, note.id, {
    cloud_id: cloudRow.id,
    sync_status: "synced",
    created_at: LOCAL_EARLY,
    updated_at: LOCAL_EARLY,
  });

  // The user deletes locally; another device edits the same note afterwards.
  db.deleteNote(note.id);
  updateNote(db, note.id, { updated_at: LOCAL_EARLY });
  cloud.seedNote({
    client_note_id: local.client_note_id,
    title: "Doomed",
    content: "edited elsewhere after the delete",
    updated_at: "2026-07-20T11:30:00.000Z",
  });

  // The delete push fails this pass, so the tombstone is still local when the
  // pull runs in the same syncAll.
  cloud.failNext("DELETE /api/notes/delete", { status: 500, error: "boom" });

  await service.syncAll(true);

  const afterPull = db.getNote(note.id);
  assert.ok(afterPull, "the tombstone row must still exist locally");
  assert.ok(
    afterPull.deleted_at,
    "the pull must not resurrect a locally deleted note over its tombstone"
  );
  assert.equal(afterPull.sync_status, "pending", "the pending delete must stay pushable");

  await service.syncAll(true);

  assert.equal(db.getNote(note.id), null, "the second pass pushes the delete and clears the row");
  assert.ok(cloud.note(cloudRow.id).deleted_at, "the cloud row ends up tombstoned");
});

test("a never-synced pending note delete makes no cloud call", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, api, service } = ctx;
  silenceConsoleErrors(t);

  // Defense in depth: getPendingNoteDeletes filters cloud_id in SQL today, so a
  // null can only arrive through a regressed query or bridge. Simulate that.
  api.getPendingNoteDeletes = async () => [
    { id: 41, cloud_id: null, client_note_id: "never-synced" },
  ];

  await service.syncAll(true);

  assert.equal(
    cloud.logFor("/api/notes/delete").length,
    0,
    "a delete without a cloud id must never reach the cloud"
  );
});

test("a never-synced pending conversation delete makes no cloud call", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, api, service } = ctx;
  silenceConsoleErrors(t);

  api.getPendingConversationDeletes = async () => [
    { id: 41, cloud_id: null, client_conversation_id: "never-synced" },
  ];

  await service.syncAll(true);

  assert.equal(
    cloud.logFor("/api/conversations/delete").length,
    0,
    "a conversation delete without a cloud id must never reach the cloud"
  );
});

test("a note create attempt is recorded only while the note keeps the identity being sent", (t) => {
  const db = createDb(t);
  if (!db) return;
  const kept = db.saveNote("Kept", "body").note;
  const forked = db.saveNote("Forked", "body").note;
  const gone = db.saveNote("Gone", "body").note;
  db.updateNote(forked.id, { client_note_id: randomUUID(), cloud_id: null });
  db.hardDeleteNote(gone.id);

  assert.deepEqual(
    db.markNoteCreatesAttempted([kept.client_note_id, forked.client_note_id, gone.client_note_id]),
    [kept.client_note_id]
  );
  assert.equal(attempted(db, "notes", kept.id), 1);
  assert.equal(attempted(db, "notes", forked.id), 0);
});

test("a chat create attempt is recorded only while the chat exists", (t) => {
  const db = createDb(t);
  if (!db) return;
  const chat = db.createAgentConversation("Chat");
  const gone = db.createAgentConversation("Gone");
  db.hardDeleteConversation(gone.id);

  assert.deepEqual(db.markConversationCreateAttempted(chat.id), { success: true });
  assert.deepEqual(db.markConversationCreateAttempted(gone.id), { success: false });
  assert.equal(attempted(db, "agent_conversations", chat.id), 1);
});

test("an upgrade counts a note whose last create failed as a create attempt", (t) => {
  const db = createDb(t);
  if (!db) return;
  const failed = db.saveNote("Failed", "body").note;
  db.markNoteSyncError(failed.id);
  const fresh = db.saveNote("Fresh", "body").note;

  reopenWithoutCreateAttempts(db);

  assert.equal(attempted(db, "notes", failed.id), 1);
  assert.equal(attempted(db, "notes", fresh.id), 0);
});

test("every note and chat create is recorded as attempted before its request is sent", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, api, service } = ctx;
  silenceConsoleErrors(t);
  const flagAtSend = new Map();
  const send = api.cloudApiRequest;
  api.cloudApiRequest = async (opts) => {
    if (opts.path === "/api/notes/create" || opts.path === "/api/notes/batch-create") {
      for (const { client_note_id: clientId } of opts.body.notes ?? [opts.body]) {
        flagAtSend.set(clientId, db.getNoteByClientId(clientId).cloud_create_attempted);
      }
    }
    if (opts.path === "/api/conversations/create") {
      const clientId = opts.body.client_conversation_id;
      flagAtSend.set(clientId, db.getConversationByClientId(clientId).cloud_create_attempted);
    }
    return send(opts);
  };

  const batched = db.saveNote("Batched", "body").note;
  const chat = db.createAgentConversation("Chat");
  db.addAgentMessage(chat.id, "user", "hello");
  await service.syncAll(true);
  const single = db.saveNote("Single", "body").note;
  await service.pushNote(single.id);
  const migrated = db.saveNote("Migrated", "body").note;
  api.getNotes = async () => [db.getNote(migrated.id)];
  await require("../../src/stores/noteStore.ts").startMigration();

  assert.deepEqual(Object.fromEntries(flagAtSend), {
    [batched.client_note_id]: 1,
    [chat.client_conversation_id]: 1,
    [single.client_note_id]: 1,
    [migrated.client_note_id]: 1,
  });
});

test("a note given a new identity after a sync pass read it is not sent under the old one", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  silenceConsoleErrors(t);
  const note = db.saveNote("Forked mid-pass", "body").note;
  const oldClientId = note.client_note_id;
  afterPendingRead(api, note.id, () =>
    db.updateNote(note.id, { client_note_id: randomUUID(), cloud_id: null })
  );

  await service.syncAll(true);
  await service.syncAll(true);

  assert.equal(batchCreatedClientIds(cloud).includes(oldClientId), false);
  assert.equal(cloud.note(oldClientId), null);
  const synced = db.getNote(note.id);
  assert.equal(synced.sync_status, "synced");
  assert.equal(cloud.note(synced.client_note_id).id, synced.cloud_id);
});

test("deleting a never-synced note removes it with its chats, speaker names and search words", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote(
    "Board meeting zebracorn",
    "Confidential zebracorn plan",
    "meeting"
  ).note;
  db.setSpeakerMapping(note.id, "speaker_0", null, "Alice");
  db.saveNoteSpeakerEmbeddings(note.id, {
    speaker_0: Buffer.from(new Float32Array([0.1, 0.2]).buffer),
  });
  const localChat = db.createAgentConversation("Local chat", note.id);
  db.addAgentMessage(localChat.id, "user", "zebracorn?");
  const syncedChat = db.createAgentConversation("Synced chat", note.id);
  db.markConversationSynced(syncedChat.id, "cloud-conv-synced");
  db.addAgentMessage(syncedChat.id, "user", "synced zebracorn");

  assert.deepEqual(db.deleteNote(note.id), { success: true, id: note.id });

  assert.equal(rowCount(db, "notes", note.id), 0);
  assert.deepEqual(
    db.db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?").all("zebracorn"),
    []
  );
  for (const table of ["speaker_mappings", "note_speaker_embeddings"]) {
    const rows = db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE note_id = ?`);
    assert.equal(rows.get(note.id).n, 0);
  }
  assert.equal(rowCount(db, "agent_conversations", localChat.id), 0);
  assert.equal(db.getAgentMessages(localChat.id).length, 0);
  assert.ok(db.getPendingConversationDeletes().some((chat) => chat.id === syncedChat.id));
  assert.equal(db.getAgentMessages(syncedChat.id).length, 0);
  assert.deepEqual(db.deleteNote(note.id), { success: false, id: note.id });
});

test("a note whose create was sent stays a tombstone a late create receipt turns into a cloud delete", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Sent", "body").note;
  const snapshot = db.getNote(note.id);
  db.markNoteCreatesAttempted([note.client_note_id]);

  assert.deepEqual(db.deleteNote(note.id), { success: true, id: note.id });
  assert.ok(db.getNote(note.id).deleted_at);
  const receipt = db.acknowledgeNoteCreate(
    note.id,
    snapshot,
    "cloud-late",
    "2026-10-21T10:00:00.000Z",
    null
  );
  assert.equal(receipt.outcome, "pending");
  assert.ok(
    db.getPendingNoteDeletes().some((row) => row.id === note.id && row.cloud_id === "cloud-late")
  );
});

test("deleting a note of another local account changes nothing", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const note = db.saveNote("Account A note", "body").note;
  db.setActiveAccountId("account-b");

  assert.deepEqual(db.deleteNote(note.id), { success: false, id: note.id });
  assert.equal(rowCount(db, "notes", note.id), 1);
  db.setActiveAccountId("account-a");
  assert.equal(db.getNote(note.id).deleted_at, null);
});

for (const path of ["/api/notes/batch-create", "/api/notes/create"]) {
  test(`a note deleted while its first create is in flight is deleted in the cloud and stays gone (${path})`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    silenceConsoleErrors(t);
    const note = db.saveNote("In flight", "secret zebracorn").note;
    afterCloudAnswers(
      api,
      (opts) => opts.path === path,
      () => db.deleteNote(note.id)
    );

    if (path === "/api/notes/create") await service.pushNote(note.id);
    await service.syncAll(true);
    await service.syncAll(true);

    assert.equal(db.getNoteByClientId(note.client_note_id), null);
    assert.ok(cloud.note(note.client_note_id).deleted_at);
  });
}

test("a note deleted after a sync pass read it is never uploaded", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  silenceConsoleErrors(t);
  const note = db.saveNote("Read, then deleted", "body").note;
  afterPendingRead(api, note.id, () => db.deleteNote(note.id));

  await service.syncAll(true);
  await service.syncAll(true);

  assert.equal(batchCreatedClientIds(cloud).includes(note.client_note_id), false);
  assert.equal(cloud.note(note.client_note_id), null);
  assert.equal(db.getNoteByClientId(note.client_note_id), null);
});

test("a note deleted before the legacy upload sends it is never uploaded", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api } = ctx;
  silenceConsoleErrors(t);
  const note = db.saveNote("Listed, then deleted", "body").note;
  const listed = db.getNote(note.id);
  db.deleteNote(note.id);
  api.getNotes = async () => [listed];

  await require("../../src/stores/noteStore.ts").startMigration();

  assert.equal(cloud.logFor("/api/notes/batch-create").length, 0);
  assert.equal(cloud.note(note.client_note_id), null);
});

test("a chat deleted while its create is in flight is deleted in the cloud, retrying a failed delete", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  silenceConsoleErrors(t);
  const chat = db.createAgentConversation("In flight");
  db.addAgentMessage(chat.id, "user", "secret zebracorn");
  afterCloudAnswers(
    api,
    (opts) => opts.path === "/api/conversations/create",
    () => db.deleteAgentConversation(chat.id)
  );
  cloud.failNext("DELETE /api/conversations/delete", { status: 503, error: "offline" });

  await service.syncAll(true);
  await service.syncAll(true);

  const deletes = cloud.logFor("/api/conversations/delete").map((call) => call.body.id);
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0], deletes[1]);
  assert.equal(rowCount(db, "agent_conversations", chat.id), 0);
});

test("a chat deleted after a sync pass read it is never uploaded", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  silenceConsoleErrors(t);
  const chat = db.createAgentConversation("Read, then deleted");
  db.addAgentMessage(chat.id, "user", "hello");
  const read = api.getAgentConversation;
  api.getAgentConversation = async (id) => {
    const row = await read(id);
    if (id === chat.id) {
      api.getAgentConversation = read;
      db.deleteAgentConversation(chat.id);
    }
    return row;
  };

  await service.syncAll(true);

  assert.equal(cloud.logFor("/api/conversations/create").length, 0);
  assert.equal(rowCount(db, "agent_conversations", chat.id), 0);
});

// A delete as earlier versions recorded it, whether or not the row ever synced.
function oldTombstone(db, table, id) {
  db.db
    .prepare(
      `UPDATE ${table} SET deleted_at = datetime('now'), sync_status = 'pending', updated_at = datetime('now') WHERE id = ?`
    )
    .run(id);
}

test("the update removes never-synced deletes left by earlier versions and keeps rows in use", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Old zebracorn", "deleted before the update").note;
  db.setSpeakerMapping(note.id, "speaker_0", null, "Alice");
  const noteChat = db.createAgentConversation("Chat about the old note", note.id);
  db.addAgentMessage(noteChat.id, "user", "still in use");
  oldTombstone(db, "notes", note.id);
  const chat = db.createAgentConversation("Old chat");
  db.addAgentMessage(chat.id, "user", "deleted before the update");
  oldTombstone(db, "agent_conversations", chat.id);
  const synced = db.saveNote("Synced", "awaiting its cloud delete").note;
  db.markNoteSynced(synced.id, "cloud-note-synced");
  oldTombstone(db, "notes", synced.id);
  const folder = db.createFolder("Being deleted", db.getPrivateSpaceId()).folder;
  db.markFolderSynced(folder.id, "cloud-folder-held");
  const held = db.saveNote("Held", "in a folder delete", "personal", null, null, folder.id).note;
  assert.equal(db.deleteFolder(folder.id).success, true);

  reopenWithoutCreateAttempts(db);

  assert.equal(rowCount(db, "notes", note.id), 0);
  assert.deepEqual(
    db.db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?").all("zebracorn"),
    []
  );
  const mappings = db.db.prepare("SELECT COUNT(*) AS n FROM speaker_mappings WHERE note_id = ?");
  assert.equal(mappings.get(note.id).n, 0);
  assert.equal(rowCount(db, "agent_conversations", chat.id), 0);
  assert.equal(db.getAgentMessages(chat.id).length, 0);
  assert.equal(db.getAgentMessages(noteChat.id).length, 1);
  assert.ok(db.getNote(synced.id).deleted_at);
  assert.equal(rowCount(db, "notes", held.id), 1);
});

test("the cleanup of earlier deletes runs only with the update", (t) => {
  const db = createDb(t);
  if (!db) return;
  reopenWithoutCreateAttempts(db);
  const note = db.saveNote("Deleted after the update", "body").note;
  oldTombstone(db, "notes", note.id);

  db.db.close();
  db.initDatabase();

  assert.equal(rowCount(db, "notes", note.id), 1);
});
