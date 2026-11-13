// A local tombstone must outlive a pull, a note or chat no create request has
// carried leaves the device when it is deleted, and delete pushes must never
// reach the cloud for rows that were never synced. The create races below cover
// personal Backup and teamspace notes.

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
const { createFakeCloud, createAccountCloud } = require("./harness/fakeCloud.js");
const { createSyncDevice } = require("./harness/syncDevice.js");
const { TEAM_SPACE, joinTeamSpace, saveNoteIn } = require("./harness/teamSpace.js");
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
  // As useAuth leaves it: main scoped to the account the renderer signed in as.
  db.setActiveAccountId("user-harness");
  await establishValidatedAuth("user-harness");
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

// A Private's default folder waits for a full pass to upload it; this one already has.
function linkNoteFolder(device, cloud, note) {
  const folder = device.db.getFolders().find((row) => row.id === note.folder_id);
  const remote = cloud.seedFolder({ client_folder_id: folder.client_folder_id, name: folder.name });
  device.db.markFolderSynced(folder.id, remote.id);
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
  const { db, cloud, api, service } = ctx;
  silenceConsoleErrors(t);
  const team = joinTeamSpace(db, cloud);
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

  const batched = saveNoteIn(db, team.id, "Batched", "body").note;
  const chat = db.createAgentConversation("Chat");
  db.addAgentMessage(chat.id, "user", "hello");
  await service.syncAll(true);
  const single = saveNoteIn(db, team.id, "Single", "body").note;
  await service.pushNote(single.id);
  const migrated = saveNoteIn(db, team.id, "Migrated", "body").note;
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
  const team = joinTeamSpace(db, cloud);
  const note = saveNoteIn(db, team.id, "Forked mid-pass", "body").note;
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
  const team = joinTeamSpace(db);
  const note = saveNoteIn(
    db,
    team.id,
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
  assert.equal(db.markConversationSynced(syncedChat.id, "cloud-conv-synced").success, true);
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
    const team = joinTeamSpace(db, cloud);
    const note = saveNoteIn(db, team.id, "In flight", "secret zebracorn").note;
    afterCloudAnswers(
      api,
      (opts) => opts.path === path,
      () => db.deleteNote(note.id)
    );

    if (path === "/api/notes/create") {
      await service.pushNote(note.id);
      // A teamspace push asks for a pass to reach teammates; let it finish, or
      // the passes below would only queue behind it.
      const deadline = Date.now() + 5000;
      while (service.syncing) {
        assert.ok(Date.now() < deadline, "the pass a teamspace push asked for never finished");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
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
  const team = joinTeamSpace(db, cloud);
  const note = saveNoteIn(db, team.id, "Read, then deleted", "body").note;
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
  const team = joinTeamSpace(db, cloud);
  const note = saveNoteIn(db, team.id, "Listed, then deleted", "body").note;
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

// --- Private notes stay on the device (D2, D11) ------------------------------

function sentConversationIds(cloud) {
  return cloud.logFor("/api/conversations/create").map((call) => call.body.client_conversation_id);
}

test("a chat on a private note is not uploaded; a root chat is", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const note = db.saveNote("Private", "body").note;
  const noteChat = db.createAgentConversation("About my note", note.id);
  db.addAgentMessage(noteChat.id, "user", "private question");
  // A legacy shared note keeps syncing for its guests, who never see its chats.
  const shared = db.saveNote("Shared earlier", "body").note;
  updateNote(db, shared.id, { cloud_id: "cloud-shared", is_shared: 1, sync_status: "synced" });
  const sharedChat = db.createAgentConversation("About the shared note", shared.id);
  db.addAgentMessage(sharedChat.id, "user", "still private");
  const rootChat = db.createAgentConversation("Root");
  db.addAgentMessage(rootChat.id, "user", "backed up");

  await service.syncAll(true);
  await service.pushEntity("conversation", noteChat.id);
  await service.pushEntity("conversation", sharedChat.id);

  assert.deepEqual(sentConversationIds(cloud), [rootChat.client_conversation_id]);
  assert.equal(cloud.conversations().length, 1);
  assert.ok(db.getAgentConversation(rootChat.id).cloud_id);
  for (const chat of [noteChat, sharedChat]) {
    assert.equal(db.getAgentConversation(chat.id).cloud_id, null);
    assert.equal(attempted(db, "agent_conversations", chat.id), 0);
  }
  assert.deepEqual(
    db.getPendingConversations().map((chat) => chat.id),
    [],
    "no sync pass reads a private note's chat for upload"
  );
});

test("ensureNoteSynced returns an existing personal cloud copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const backedUp = db.saveNote("Backed up", "body").note;
  updateNote(db, backedUp.id, { cloud_id: "cloud-backed-up", sync_status: "synced" });
  const shared = db.saveNote("Shared earlier", "body").note;
  updateNote(db, shared.id, { cloud_id: "cloud-shared", is_shared: 1, sync_status: "synced" });
  assert.equal(await service.ensureNoteSynced(backedUp.id), "cloud-backed-up");
  assert.equal(await service.ensureNoteSynced(shared.id), "cloud-shared");
  assert.deepEqual(cloud.log, [], "existing identities need no new upload");
});

for (const replacement of ["source-account", "other-account"]) {
  for (const phase of ["existing", "pending", "receipt"]) {
    test(`sharing preflight refuses ${phase} after sign-in replacement by ${replacement}`, async (t) => {
      const device = createSyncDevice(t);
      if (!device) return;
      const source = createAccountCloud();
      const other = createAccountCloud();
      await device.signIn("source-account", source);
      const note = device.db.saveNote("Source private", "source secret").note;
      if (phase === "existing") {
        const remote = source.seedNote({ client_note_id: note.client_note_id, title: note.title });
        device.db.markNoteSynced(note.id, remote.id, remote.updated_at, "source-account");
      }
      const getNote = device.api.getNote;
      let switched = false;
      device.api.getNote = async (id) => {
        const read = await getNote(id);
        if (!switched && (phase !== "receipt" || read?.sync_status === "synced")) {
          switched = true;
          await device.signIn(replacement, replacement === "source-account" ? source : other);
        }
        return read;
      };
      assert.equal(await device.service.ensureNoteSynced(note.id), null);
      assert.equal(switched, true);
      assert.equal(other.log.length, 0, "the replacement account receives no request");
      assert.equal(source.logFor("/api/notes/create").length, phase === "receipt" ? 1 : 0);
    });
  }
}

for (const changedField of ["client_note_id", "space_id", "cloud_id"]) {
  test(`sharing consent does not follow a changed ${changedField} while waiting to push`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    const note = db.saveNote("Selected", "selected text").note;
    updateNote(db, note.id, { cloud_id: "original-cloud-id" });
    const replacement =
      changedField === "space_id"
        ? db.getPrivateSpaceId("another-workspace")
        : "replacement-identity";
    const getNote = api.getNote;
    let changed = false;
    api.getNote = async (id) => {
      const read = await getNote(id);
      if (!changed) {
        changed = true;
        updateNote(db, id, { [changedField]: replacement });
      }
      return read;
    };
    assert.equal(await service.ensureNoteSynced(note.id), null);
    assert.equal(cloud.log.filter((call) => call.method !== "GET").length, 0);
    assert.equal(db.getNote(note.id).content, "selected text");
    assert.equal(db.getNote(note.id).sync_status, "pending");
  });
}

test("sharing receipt does not adopt a replaced local note identity", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, api, service } = ctx;
  const note = db.saveNote("Selected", "selected text").note;
  const getNote = api.getNote;
  api.getNote = async (id) => {
    const read = await getNote(id);
    if (read?.sync_status !== "synced") return read;
    return updateNote(db, id, { client_note_id: "replacement-identity" });
  };
  assert.equal(await service.ensureNoteSynced(note.id), null);
});

test("explicit sharing with Backup off uploads only the selected Private note", async (t) => {
  const device = createSyncDevice(t);
  if (!device) return;
  const cloud = createAccountCloud({ privateWorkspacePlacement: true });
  await device.signIn("source-account", cloud);
  device.db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-b",
    defaultWorkspaceId: "workspace-a",
  });
  device.db.bindDefaultPrivateSpace("workspace-a");
  const privateId = device.db.getPrivateSpaceId("workspace-b");
  const folder = device.db.createFolder("Only on this device", privateId).folder;
  const selected = saveNoteIn(device.db, privateId, "Share this", "selected content").note;
  device.db.updateNote(selected.id, { folder_id: folder.id });
  const unrelated = saveNoteIn(device.db, privateId, "Keep local", "unrelated content").note;
  const chat = device.db.createAgentConversation("Private conversation", selected.id);
  device.db.addAgentMessage(chat.id, "user", "private chat content");
  windowStub.localStorage.setItem("cloudBackupEnabled", "false");
  await device.service.pushEntity("note", selected.id);
  assert.equal(cloud.notes().length, 0, "ordinary pushes still honor Backup off");

  const cloudId = await device.service.ensureNoteSynced(selected.id);
  assert.ok(cloudId, JSON.stringify({ local: device.db.getNote(selected.id), calls: cloud.log }));
  assert.equal(cloud.note(cloudId).content, "selected content");
  assert.equal(cloud.note(cloudId).private_workspace_id, "workspace-b");
  assert.equal(cloud.note(cloudId).folder_id, null);
  const after = device.db.getNote(selected.id);
  assert.equal(after.space_id, privateId);
  assert.equal(after.folder_id, folder.id);
  assert.equal(after.is_shared, 0, "upload consent does not invent an audience");
  assert.equal(after.client_note_id, selected.client_note_id);
  assert.equal(device.db.getNote(unrelated.id).cloud_id, null);
  assert.equal(device.db.getAgentConversation(chat.id).cloud_id, null);
  assert.equal(cloud.notes().length, 1);
  assert.equal(cloud.folders().length, 0);
  assert.equal(cloud.conversations().length, 0);
  assert.equal(windowStub.localStorage.getItem("cloudBackupEnabled"), "false");
});

test("the legacy upload sends a teamspace note with its scope, so it never lands as personal", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api } = ctx;
  const team = joinTeamSpace(db, cloud);
  const note = saveNoteIn(db, team.id, "Team draft", "body").note;
  api.getNotes = async () => [db.getNote(note.id)];

  await require("../../src/stores/noteStore.ts").startMigration();

  const [batch] = cloud.logFor("/api/notes/batch-create");
  assert.equal(batch.body.notes[0].space_id, TEAM_SPACE.id);
  assert.equal(batch.body.notes[0].workspace_id, TEAM_SPACE.workspace_id);
  assert.equal(cloud.note(note.client_note_id).space_id, TEAM_SPACE.id);
});

test("enabling Backup uploads an ordinary Private note", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api } = ctx;
  db.bindDefaultPrivateSpace("personal-workspace");
  const note = db.saveNote("Private", "body").note;
  api.getNotes = async () => [db.getNote(note.id)];

  await require("../../src/stores/noteStore.ts").startMigration();

  assert.equal(cloud.note(note.client_note_id).content, "body");
  assert.equal(cloud.note(note.client_note_id).space_id ?? null, null);
  assert.equal(
    cloud.logFor("/api/notes/batch-create")[0].body.notes[0].private_workspace_id,
    "personal-workspace"
  );
  assert.ok(db.getNote(note.id).cloud_id);
  assert.equal(attempted(db, "notes", note.id), 1);
});

test("the Backup upload sweep does nothing while Backup is off", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  localStorage.setItem("cloudBackupEnabled", "false");
  const note = db.saveNote("Private", "body").note;

  await require("../../src/stores/noteStore.ts").startMigration();

  assert.deepEqual(cloud.log, []);
  assert.equal(db.getNote(note.id).cloud_id, null);
  assert.equal(attempted(db, "notes", note.id), 0);
});

test("deleting a private note queues deletion of its historical chat backup", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("user-harness");
  const note = db.saveNote("Private note", "private body").note;
  const chat = db.createAgentConversation("Private chat", note.id);
  db.addAgentMessage(chat.id, "user", "private message");
  assert.equal(db.getAgentConversation(chat.id).device_only, 1);
  assert.equal(db.markConversationSynced(chat.id, "must-not-upload").success, false);
  // This cloud link predates the private-chat protection.
  db.db
    .prepare("UPDATE agent_conversations SET cloud_id = ?, sync_status = 'synced' WHERE id = ?")
    .run("historical-backup", chat.id);

  assert.equal(db.deleteNote(note.id).success, true);
  const queued = db.getPendingConversationDeletes().find((row) => row.id === chat.id);
  assert.equal(queued?.cloud_id, "historical-backup");
  assert.equal(queued.device_only, 1);
  assert.ok(queued.deleted_at);
  assert.deepEqual(db.getAgentMessages(chat.id), []);
});

for (const mode of ["normal pass", "isolated push", "Backup enable sweep"]) {
  test(`${mode} never sends a previous account's note after its create journal await`, async (t) => {
    const { createSyncDevice } = require("./harness/syncDevice.js");
    const { createAccountCloud } = require("./harness/fakeCloud.js");
    const device = createSyncDevice(t);
    if (!device) return;
    silenceConsoleErrors(t);
    const source = createAccountCloud();
    const replacement = createAccountCloud();
    await device.signIn("source-account", source);
    device.db.bindDefaultPrivateSpace("source-workspace");
    const note = device.db.saveNote("Source private", "Source content").note;
    linkNoteFolder(device, source, note);
    device.api.getNotes = async () => [device.db.getNote(note.id)];
    const record = device.api.markNoteCreatesAttempted;
    device.api.markNoteCreatesAttempted = async (...args) => {
      const recorded = await record(...args);
      await device.signIn("replacement-account", replacement);
      return recorded;
    };
    if (mode === "normal pass") await device.service.syncAll(true);
    else if (mode === "Backup enable sweep")
      await require("../../src/stores/noteStore.ts").startMigration();
    else
      await assert.rejects(
        device.service.pushNote(note.id),
        (error) => error.code === "AUTH_CONTEXT_CHANGED"
      );
    assert.equal(replacement.logFor("/api/notes/batch-create").length, 0);
    assert.equal(replacement.logFor("/api/notes/create").length, 0);
    assert.equal(replacement.logFor("/api/notes/delete").length, 0);
    device.db.setActiveAccountId("source-account");
    assert.equal(device.db.getNote(note.id).cloud_id, null);
    assert.equal(device.db.getNote(note.id).content, "Source content");
  });
}

for (const mode of [
  "folder create",
  "folder update",
  "isolated folder",
  "note delete",
  "folder delete",
]) {
  test(`${mode} stays pinned if its local queue read overlaps an account switch`, async (t) => {
    const { createSyncDevice } = require("./harness/syncDevice.js");
    const { createAccountCloud } = require("./harness/fakeCloud.js");
    const device = createSyncDevice(t);
    if (!device) return;
    silenceConsoleErrors(t);
    const source = createAccountCloud();
    const replacement = createAccountCloud();
    await device.signIn("source-account", source);
    device.db.bindDefaultPrivateSpace("source-workspace");
    const folder = device.db.createFolder(
      "Source folder",
      device.db.getDefaultPrivateSpaceId()
    ).folder;
    if (mode === "folder update" || mode === "folder delete") {
      const remote = source.seedFolder({
        client_folder_id: folder.client_folder_id,
        name: folder.name,
      });
      device.db.markFolderSynced(folder.id, remote.id);
      if (mode === "folder delete") device.db.deleteFolder(folder.id);
      else device.db.renameFolder(folder.id, "Private rename");
    }
    if (mode === "note delete") {
      const note = device.db.saveNote("Source note", "Text").note;
      const remote = source.seedNote({ client_note_id: note.client_note_id });
      device.db.markNoteSynced(note.id, remote.id);
      device.db.deleteNote(note.id);
    }
    const readName =
      mode === "note delete"
        ? "getPendingNoteDeletes"
        : mode === "folder delete"
          ? "getPendingFolderDeletes"
          : mode === "isolated folder"
            ? "getFolders"
            : "getPendingFolders";
    const read = device.api[readName];
    device.api[readName] = async (...args) => {
      const rows = await read(...args);
      await device.signIn("replacement-account", replacement);
      return rows;
    };
    const run =
      mode === "note delete"
        ? () => device.service.pushNoteDeletes()
        : mode === "folder delete"
          ? () => device.service.pushFolderDeletes()
          : mode === "isolated folder"
            ? () => device.service.pushFolder(folder.id)
            : () => device.service.pushPendingFolders();
    await assert.rejects(run, (error) => error.code === "AUTH_CONTEXT_CHANGED");
    assert.equal(replacement.log.filter((call) => call.method !== "GET").length, 0);
  });
}

test("a note create response cannot acknowledge into a replacement account", async (t) => {
  const { createSyncDevice } = require("./harness/syncDevice.js");
  const { createAccountCloud } = require("./harness/fakeCloud.js");
  const device = createSyncDevice(t);
  if (!device) return;
  const source = createAccountCloud();
  const replacement = createAccountCloud();
  await device.signIn("source-account", source);
  device.db.bindDefaultPrivateSpace("source-workspace");
  const note = device.db.saveNote("Source note", "Retain pending").note;
  linkNoteFolder(device, source, note);
  const acknowledge = device.api.acknowledgeNoteCreate;
  device.api.acknowledgeNoteCreate = async (...args) => {
    await device.signIn("replacement-account", replacement);
    return acknowledge(...args);
  };
  await device.service.pushNote(note.id);
  assert.equal(replacement.log.filter((call) => call.method !== "GET").length, 0);
  device.db.setActiveAccountId("source-account");
  assert.equal(device.db.getNote(note.id).cloud_id, null);
  assert.equal(device.db.getNote(note.id).sync_status, "pending");
  assert.equal(source.notes()[0].content, "Retain pending");
});

test("a pulled create receipt cannot acknowledge after the sign-in is replaced", async (t) => {
  const { createSyncDevice } = require("./harness/syncDevice.js");
  const { createAccountCloud } = require("./harness/fakeCloud.js");
  const device = createSyncDevice(t);
  if (!device) return;
  silenceConsoleErrors(t);
  const source = createAccountCloud();
  const replacement = createAccountCloud();
  await device.signIn("source-account", source);
  device.db.bindDefaultPrivateSpace("source-workspace");
  const note = device.db.saveNote("Source note", "Retain pending").note;
  const remote = source.seedNote({
    client_note_id: note.client_note_id,
    title: note.title,
    content: note.content,
  });
  device.db.acknowledgeNoteCreate(note.id, note, remote.id, remote.updated_at, null, {
    requiresReconciliation: true,
    settleIfUnchanged: true,
    cloudRevision: remote.revision,
  });
  const acknowledge = device.api.acknowledgeNoteCreate;
  let acknowledgements = 0;
  device.api.acknowledgeNoteCreate = async (...args) => {
    acknowledgements++;
    await device.signIn("source-account", replacement);
    return acknowledge(...args);
  };

  assert.equal(await device.service.pullNotes(false, true), false);
  assert.equal(acknowledgements, 1);
  device.db.setActiveAccountId("source-account");
  assert.ok(device.db.getNote(note.id).cloud_create_pending);
  assert.equal(device.db.getNote(note.id).sync_status, "pending");
  assert.equal(device.db.getNote(note.id).content, "Retain pending");
});
