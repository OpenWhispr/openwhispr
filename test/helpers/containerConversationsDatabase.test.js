const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-container-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-container-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  try {
    const database = new DatabaseManager();
    database.setActiveAccountId("test-account");
    return database;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

let nextTestTeamSpaceId = 0;

function createTestTeamSpace(db, { name, emoji = null } = {}) {
  const maxOrder = db.db.prepare("SELECT MAX(sort_order) AS max_order FROM spaces").get();
  const result = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, emoji, sort_order) VALUES (?, 'team', ?, ?, ?)"
    )
    .run(
      `test-container-space-${++nextTestTeamSpaceId}`,
      name,
      emoji,
      (maxOrder?.max_order ?? 0) + 1
    );
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(result.lastInsertRowid, "test-account");
  return { success: true, space: db.getSpace(result.lastInsertRowid) };
}

test("container scope migration is idempotent across launches", (t) => {
  const db = createDb(t);
  if (!db) return;

  const columns = db.db.pragma("table_info('agent_conversations')").map((col) => col.name);
  assert.ok(columns.includes("space_id"));
  assert.ok(columns.includes("folder_id"));

  const noteColumns = db.db.pragma("table_info('notes')").map((col) => col.name);
  assert.ok(noteColumns.includes("updated_by_user_id"));
  assert.ok(
    db.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'optimistic_folder_delete_rows'"
      )
      .get()
  );

  db.db.close();

  const db2 = new DatabaseManager();
  const indexes = db2.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_conversations'"
    )
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_agent_conversations_container"));
  assert.ok(
    db2.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'optimistic_folder_delete_rows'"
      )
      .get()
  );
});

test("createAgentConversation stores container scope", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;

  const folderConv = db.createAgentConversation("Docs", null, space.id, folder.id);
  assert.equal(folderConv.space_id, space.id);
  assert.equal(folderConv.folder_id, folder.id);

  const spaceConv = db.createAgentConversation("Eng", null, space.id);
  assert.equal(spaceConv.space_id, space.id);
  assert.equal(spaceConv.folder_id, null);

  const globalConv = db.createAgentConversation("Global");
  assert.equal(globalConv.space_id, null);
  assert.equal(globalConv.folder_id, null);
  assert.equal(globalConv.note_id, null);
});

test("getPendingConversations excludes scopes the cloud contract cannot preserve", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;
  const note = db.saveNote("Note", "body").note;

  const global = db.createAgentConversation("Global");
  const noteScoped = db.createAgentConversation("Note chat", note.id);
  db.createAgentConversation("Space chat", null, space.id);
  db.createAgentConversation("Folder chat", null, space.id, folder.id);

  assert.deepEqual(
    db.getPendingConversations().map((conversation) => conversation.id),
    [global.id, noteScoped.id],
    "space/folder chats must remain local until the cloud API carries their scope"
  );
});

test("getConversationsForContainer separates folder and space-root scopes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;

  const folderConv = db.createAgentConversation("Folder chat", null, space.id, folder.id);
  const spaceConv = db.createAgentConversation("Space chat", null, space.id);
  db.createAgentConversation("Global chat");
  db.addAgentMessage(folderConv.id, "user", "hello");

  const folderList = db.getConversationsForContainer(space.id, folder.id);
  assert.equal(folderList.length, 1);
  assert.equal(folderList[0].id, folderConv.id);
  assert.equal(folderList[0].message_count, 1);

  const spaceList = db.getConversationsForContainer(space.id, null);
  assert.equal(spaceList.length, 1, "space root must exclude folder-scoped conversations");
  assert.equal(spaceList[0].id, spaceConv.id);
  assert.equal(spaceList[0].message_count, 0);
});

test("getConversationsForContainer excludes deleted conversations", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;

  const conv = db.createAgentConversation("Doomed", null, space.id);
  db.db
    .prepare("UPDATE agent_conversations SET deleted_at = datetime('now') WHERE id = ?")
    .run(conv.id);

  assert.equal(db.getConversationsForContainer(space.id, null).length, 0);
});

test("global conversation lists and search exclude space and folder chats", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;
  const note = db.saveNote("Roadmap source", "body").note;

  const global = db.createAgentConversation("Roadmap global");
  const archivedGlobal = db.createAgentConversation("Roadmap archived");
  const noteScoped = db.createAgentConversation("Roadmap note", note.id);
  const spaceScoped = db.createAgentConversation("Roadmap space", null, space.id);
  const folderScoped = db.createAgentConversation("Roadmap folder", null, space.id, folder.id);
  db.archiveAgentConversation(archivedGlobal.id);
  db.addAgentMessage(global.id, "user", "roadmap");
  db.addAgentMessage(noteScoped.id, "user", "roadmap");
  db.addAgentMessage(spaceScoped.id, "user", "roadmap");
  db.addAgentMessage(folderScoped.id, "user", "roadmap");

  assert.deepEqual(
    new Set(db.getAgentConversations().map((conversation) => conversation.id)),
    new Set([global.id, archivedGlobal.id, noteScoped.id])
  );
  assert.deepEqual(
    new Set(db.getAgentConversationsWithPreview().map((conversation) => conversation.id)),
    new Set([noteScoped.id, global.id])
  );
  assert.deepEqual(
    db.getAgentConversationsWithPreview(50, 0, true).map((conversation) => conversation.id),
    [archivedGlobal.id]
  );
  assert.deepEqual(
    new Set(db.searchAgentConversations("roadmap").map((conversation) => conversation.id)),
    new Set([global.id, noteScoped.id])
  );
  assert.equal(db.getConversationsForContainer(space.id, null)[0].id, spaceScoped.id);
  assert.equal(db.getConversationsForContainer(space.id, folder.id)[0].id, folderScoped.id);
});

test("searchNotes filters by folder", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;

  db.saveNote("Roadmap planning", "quarterly roadmap", "personal", null, null, folder.id, space.id);
  db.saveNote("Roadmap ideas", "more roadmap", "personal", null, null, null, space.id);

  const spaceHits = db.searchNotes("roadmap", 10, space.id);
  assert.equal(spaceHits.length, 2);

  const folderHits = db.searchNotes("roadmap", 10, space.id, folder.id);
  assert.equal(folderHits.length, 1);
  assert.equal(folderHits[0].folder_id, folder.id);
});

test("getNotesForSpace includes foldered notes, unlike the root-only getNotes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;

  const rootNote = db.saveNote("Root", "", "personal", null, null, null, space.id).note;
  const folderNote = db.saveNote("Foldered", "", "personal", null, null, folder.id, space.id).note;
  db.deleteNote(folderNote.id);
  const keptNote = db.saveNote("Kept", "", "personal", null, null, folder.id, space.id).note;

  const rootOnly = db.getNotes(null, 50, null, space.id);
  assert.deepEqual(
    rootOnly.map((n) => n.id),
    [rootNote.id]
  );

  const all = db.getNotesForSpace(space.id);
  assert.deepEqual(new Set(all.map((n) => n.id)), new Set([rootNote.id, keptNote.id]));
});

test("getNoteIdsInFolder excludes deleted notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;

  const kept = db.saveNote("Kept", "", "personal", null, null, folder.id, space.id).note;
  const removed = db.saveNote("Removed", "", "personal", null, null, folder.id, space.id).note;
  db.deleteNote(removed.id);

  assert.deepEqual(db.getNoteIdsInFolder(folder.id), [kept.id]);
});

test("getNoteIdsInScope validates vector candidates against the current SQLite scope", (t) => {
  const db = createDb(t);
  if (!db) return;
  const eng = createTestTeamSpace(db, { name: "Eng" }).space;
  const design = createTestTeamSpace(db, { name: "Design" }).space;
  const engFolder = db.createFolder("Docs", eng.id).folder;

  const engRoot = db.saveNote("Eng root", "", "personal", null, null, null, eng.id).note;
  const engFiled = db.saveNote("Eng filed", "", "personal", null, null, engFolder.id, eng.id).note;
  const designRoot = db.saveNote("Design root", "", "personal", null, null, null, design.id).note;
  const deleted = db.saveNote("Deleted", "", "personal", null, null, null, eng.id).note;
  db.deleteNote(deleted.id);

  assert.deepEqual(new Set(db.getNoteIdsInScope(eng.id)), new Set([engRoot.id, engFiled.id]));
  assert.deepEqual(db.getNoteIdsInScope(eng.id, engFolder.id), [engFiled.id]);
  assert.deepEqual(db.getNoteIdsInScope(design.id, engFolder.id), []);
  assert.deepEqual(db.getNoteIdsInScope(design.id), [designRoot.id]);
  assert.deepEqual(
    db.getNoteIdsInScope(eng.id, null, [engRoot.id, designRoot.id, deleted.id]),
    [engRoot.id],
    "stale vector candidates are filtered by live local scope"
  );
});

test("upsertNoteFromCloud preserves omitted and clears explicit-null updated_by_user_id", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();

  const cloudNote = {
    id: "cloud-1",
    client_note_id: "client-1",
    title: "Synced",
    content: "body",
    updated_by_user_id: "user-a",
    created_at: "2026-07-01 10:00:00",
    updated_at: "2026-07-01 10:00:00",
  };
  const inserted = db.upsertNoteFromCloud(cloudNote, null, privateId);
  assert.equal(inserted.updated_by_user_id, "user-a");

  const updated = db.upsertNoteFromCloud(
    { ...cloudNote, updated_by_user_id: "user-b", updated_at: "2026-07-02 10:00:00" },
    null,
    privateId
  );
  assert.equal(updated.updated_by_user_id, "user-b");

  const cloudNoteWithoutUpdater = { ...cloudNote };
  delete cloudNoteWithoutUpdater.updated_by_user_id;

  // Older API responses that omit the field must keep the last known editor.
  const unchanged = db.upsertNoteFromCloud(
    { ...cloudNoteWithoutUpdater, updated_at: "2026-07-03 10:00:00" },
    null,
    privateId
  );
  assert.equal(unchanged.updated_by_user_id, "user-b");

  // Explicit null clears attribution after the former user is deleted.
  const cleared = db.upsertNoteFromCloud(
    { ...cloudNote, updated_by_user_id: null, updated_at: "2026-07-04 10:00:00" },
    null,
    privateId
  );
  assert.equal(cleared.updated_by_user_id, null);
});

// Container conversations die with their container (space purge, folder
// delete, revocation): synced rows tombstone so the next push retires the
// cloud copy — a hard local delete would let the next pull resurrect the
// conversation as a global one — while never-synced rows hard-delete
// outright (no server row to retire).

test("purgeSpace retires the space's container conversations", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;

  const syncedConv = db.createAgentConversation("Synced", null, space.id);
  db.markConversationSynced(syncedConv.id, "cloud-conv-1");
  const localConv = db.createAgentConversation("Local only", null, space.id, folder.id);
  db.addAgentMessage(localConv.id, "user", "hello");
  const globalConv = db.createAgentConversation("Global");

  assert.equal(db.purgeSpace(space.id).success, true);

  const tombstoned = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(syncedConv.id);
  assert.ok(tombstoned.deleted_at, "synced conversation must tombstone for the delete push");
  assert.equal(tombstoned.sync_status, "pending");

  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM agent_conversations WHERE id = ?").get(localConv.id).n,
    0
  );
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id = ?")
      .get(localConv.id).n,
    0
  );

  const global = db.db.prepare("SELECT * FROM agent_conversations WHERE id = ?").get(globalConv.id);
  assert.equal(global.deleted_at, null, "unscoped conversations are untouched");
});

test("live cloud upserts never rehydrate local conversation tombstones", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Secret" }).space;

  const purged = db.createAgentConversation("Purged chat", null, space.id);
  db.markConversationSynced(purged.id, "cloud-conv-purged");
  db.addAgentMessage(purged.id, "user", "sensitive team content");
  assert.equal(db.purgeSpace(space.id).success, true);
  assert.equal(db.getAgentMessages(purged.id).length, 0);

  const ignored = db.upsertConversationFromCloud(
    {
      id: "cloud-conv-purged",
      client_conversation_id: purged.client_conversation_id,
      title: "Newer cloud copy",
      updated_at: "2099-01-01T00:00:00.000Z",
    },
    [{ role: "assistant", content: "must not come back" }]
  );
  assert.equal(ignored.id, purged.id);
  const stillPurged = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(purged.id);
  assert.ok(stillPurged.deleted_at);
  assert.equal(stillPurged.sync_status, "pending");
  assert.equal(stillPurged.title, "Purged chat");
  assert.equal(db.getAgentMessages(purged.id).length, 0);

  const optimistic = db.createAgentConversation("Recoverable chat");
  db.markConversationSynced(optimistic.id, "cloud-conv-optimistic");
  db.addAgentMessage(optimistic.id, "user", "original local message");
  assert.equal(db.deleteAgentConversation(optimistic.id).success, true);
  db.upsertConversationFromCloud(
    {
      id: "cloud-conv-optimistic",
      client_conversation_id: optimistic.client_conversation_id,
      title: "Cloud tried to restore this",
      updated_at: "2099-01-01T00:00:00.000Z",
    },
    [{ role: "assistant", content: "replacement cloud message" }]
  );
  assert.equal(
    db.getAgentMessages(optimistic.id)[0].content,
    "original local message",
    "an optimistic tombstone retains its prior recoverable content without accepting cloud updates"
  );

  const inFlightCreate = db.createAgentConversation("Delete raced create");
  assert.equal(db.deleteAgentConversation(inFlightCreate.id).success, true);
  assert.equal(db.markConversationSynced(inFlightCreate.id, "cloud-conv-late-ack").success, true);
  const queuedLateAck = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(inFlightCreate.id);
  assert.equal(queuedLateAck.cloud_id, "cloud-conv-late-ack");
  assert.ok(queuedLateAck.deleted_at);
  assert.equal(queuedLateAck.sync_status, "pending");
  assert.ok(
    db
      .getPendingConversationDeletes()
      .some((conversation) => conversation.id === inFlightCreate.id),
    "a late create acknowledgement becomes a pending cloud delete"
  );

  // This is the database action used by the cloud-tombstone branch: an
  // acknowledged remote delete still removes the local tombstone completely.
  assert.equal(db.hardDeleteConversation(purged.id).success, true);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM agent_conversations WHERE id = ?").get(purged.id).n,
    0
  );
});

test("purge rejects late writes and conversations for stale parents", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Secret" }).space;
  const folder = db.createFolder("Vault", space.id).folder;
  const note = db.saveNote("Secret note", "body", "personal", null, null, folder.id).note;
  db.markNoteSynced(note.id, "cloud-note-late-write");
  const conversation = db.createAgentConversation("Original title", note.id);
  db.markConversationSynced(conversation.id, "cloud-conv-late-write");
  db.addAgentMessage(conversation.id, "user", "purge this message");
  const localConversation = db.createAgentConversation("Local in-flight chat", note.id);
  db.addAgentMessage(localConversation.id, "user", "purge local message");

  assert.equal(db.purgeSpace(space.id).success, true);
  const tombstone = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(conversation.id);
  assert.ok(tombstone.deleted_at);
  assert.equal(db.getAgentMessages(conversation.id).length, 0);
  assert.equal(db.getAgentConversation(localConversation.id), null);
  assert.equal(db.addAgentMessage(localConversation.id, "assistant", "late local response"), null);
  assert.equal(
    db.updateAgentConversationTitle(localConversation.id, "late local title").success,
    false
  );

  assert.equal(db.addAgentMessage(conversation.id, "assistant", "late sensitive response"), null);
  assert.equal(db.getAgentMessages(conversation.id).length, 0);
  assert.equal(
    db.updateAgentConversationTitle(conversation.id, "late sensitive title").success,
    false
  );
  assert.equal(db.archiveAgentConversation(conversation.id).success, false);
  assert.equal(db.unarchiveAgentConversation(conversation.id).success, false);
  assert.equal(db.updateAgentConversationCloudId(conversation.id, "late-cloud-id").success, false);
  assert.equal(db.markConversationSynced(conversation.id, "late-cloud-id").success, true);
  const unchanged = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(conversation.id);
  assert.equal(unchanged.title, "Original title");
  assert.equal(unchanged.cloud_id, "cloud-conv-late-write");
  assert.equal(unchanged.sync_status, "pending");

  assert.equal(db.createAgentConversation("Late note chat", note.id), null);
  assert.equal(db.createAgentConversation("Late space chat", null, space.id), null);
  assert.equal(db.createAgentConversation("Late folder chat", null, space.id, folder.id), null);
  assert.ok(db.createAgentConversation("Unscoped chat"), "global chats remain valid");

  const deletedNote = db.saveNote("Soft-deleted", "body").note;
  db.deleteNote(deletedNote.id);
  assert.equal(db.createAgentConversation("Deleted note chat", deletedNote.id), null);

  const deletedSpace = createTestTeamSpace(db, { name: "Deleted scope" }).space;
  db.db.prepare("UPDATE spaces SET deleted_at = datetime('now') WHERE id = ?").run(deletedSpace.id);
  assert.equal(db.createAgentConversation("Deleted space chat", null, deletedSpace.id), null);

  const liveSpace = createTestTeamSpace(db, { name: "Live scope" }).space;
  const deletedFolder = db.createFolder("Deleted folder", liveSpace.id).folder;
  db.markFolderSynced(deletedFolder.id, "cloud-folder-deleted-parent");
  db.deleteFolder(deletedFolder.id);
  assert.equal(
    db.createAgentConversation("Deleted folder chat", null, liveSpace.id, deletedFolder.id),
    null
  );
});

test("destructive note cleanup retires chats while denied-delete cleanup preserves them", (t) => {
  const db = createDb(t);
  if (!db) return;

  const doomed = db.saveNote("Doomed", "body").note;
  const syncedChat = db.createAgentConversation("Synced note chat", doomed.id);
  db.markConversationSynced(syncedChat.id, "cloud-conv-doomed");
  db.addAgentMessage(syncedChat.id, "user", "remove after confirmed delete");
  const localChat = db.createAgentConversation("Local note chat", doomed.id);
  db.addAgentMessage(localChat.id, "user", "remove local chat");

  assert.equal(db.hardDeleteNote(doomed.id).success, true);
  const syncedTombstone = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(syncedChat.id);
  assert.ok(syncedTombstone.deleted_at);
  assert.equal(syncedTombstone.sync_status, "pending");
  assert.equal(db.getAgentMessages(syncedChat.id).length, 0);
  assert.equal(db.getAgentConversation(localChat.id), null);
  assert.deepEqual(db.getConversationsForNote(doomed.id), []);

  const recoverable = db.saveNote("Denied delete", "body").note;
  db.markNoteSynced(recoverable.id, "cloud-note-recoverable");
  const recoverableChat = db.createAgentConversation("Keep on denial", recoverable.id);
  db.markConversationSynced(recoverableChat.id, "cloud-conv-recoverable");
  db.addAgentMessage(recoverableChat.id, "user", "restore with server note");

  assert.equal(db.deleteNote(recoverable.id).success, true);
  assert.equal(db.restoreNoteAfterDeniedDelete(recoverable.id).success, true);
  const revived = db.getNote(recoverable.id);
  assert.equal(revived.id, recoverable.id);
  assert.equal(revived.deleted_at, null);
  assert.equal(revived.sync_status, "synced");
  assert.equal(revived.updated_at, "1970-01-01 00:00:00");

  const pulled = db.upsertNoteFromCloud(
    {
      id: "cloud-note-recoverable",
      client_note_id: recoverable.client_note_id,
      title: "Authoritative server note",
      content: "server body",
      created_at: recoverable.created_at,
      updated_at: "2026-07-29 12:00:00",
    },
    null,
    db.getPrivateSpaceId()
  );
  assert.equal(pulled.id, recoverable.id, "snapshot restore keeps the numeric note identity");
  assert.equal(pulled.title, "Authoritative server note");
  const preserved = db.getAgentConversation(recoverableChat.id);
  assert.equal(preserved.note_id, recoverable.id);
  assert.equal(preserved.deleted_at, null);
  assert.equal(preserved.messages.length, 1);
});

test("denied folder delete restores the same notes, speakers, and conversations in place", (t) => {
  let db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;
  db.markFolderSynced(folder.id, "cloud-folder-denied");
  const child = db.saveNote("Child", "body", "personal", null, null, folder.id).note;
  db.markNoteSynced(child.id, "cloud-note-child");
  const localChild = db.saveNote(
    "Local draft",
    "never uploaded",
    "personal",
    null,
    null,
    folder.id
  ).note;
  db.setSpeakerMapping(child.id, "SPEAKER_00", null, "Alice");
  db.saveNoteSpeakerEmbeddings(child.id, { SPEAKER_00: Buffer.from([1, 2, 3, 4]) });

  const childNoteConv = db.createAgentConversation("Child note chat", child.id);
  db.markConversationSynced(childNoteConv.id, "cloud-conv-child");
  db.addAgentMessage(childNoteConv.id, "user", "keep while folder delete is pending");
  const localNoteConv = db.createAgentConversation("Local note chat", localChild.id);
  db.addAgentMessage(localNoteConv.id, "user", "local note chat survives denial");
  const localFolderConv = db.createAgentConversation("Folder chat", null, space.id, folder.id);
  db.addAgentMessage(localFolderConv.id, "user", "local folder chat survives denial");
  const syncedFolderConv = db.createAgentConversation(
    "Synced folder chat",
    null,
    space.id,
    folder.id
  );
  db.markConversationSynced(syncedFolderConv.id, "cloud-conv-1");
  db.addAgentMessage(syncedFolderConv.id, "user", "recoverable until delete is accepted");
  const alreadyDeleted = db.createAgentConversation("Already deleted", null, space.id, folder.id);
  db.markConversationSynced(alreadyDeleted.id, "cloud-conv-already-deleted");
  db.addAgentMessage(alreadyDeleted.id, "user", "independent tombstone");
  db.deleteAgentConversation(alreadyDeleted.id);
  const spaceConv = db.createAgentConversation("Space chat", null, space.id);

  assert.equal(db.deleteFolder(folder.id).success, true);
  const hiddenFolder = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.ok(hiddenFolder.deleted_at);
  assert.equal(hiddenFolder.name, "Docs", "rollback keeps the original folder name in place");
  assert.ok(!db.getFolders(space.id).some((candidate) => candidate.id === folder.id));
  assert.deepEqual(db.getNotes(null, 100, folder.id), []);
  assert.equal(
    db.createFolder("Docs", space.id).success,
    false,
    "a held folder reserves its name so rollback cannot collide"
  );

  const hiddenChild = db.getNote(child.id);
  const hiddenLocalChild = db.getNote(localChild.id);
  assert.ok(hiddenChild.deleted_at);
  assert.ok(hiddenLocalChild.deleted_at);
  assert.equal(hiddenChild.sync_status, "folder_delete_pending");
  assert.equal(hiddenLocalChild.sync_status, "folder_delete_pending");
  assert.equal(db.getNoteByClientId(child.client_note_id).folder_delete_pending, 1);
  assert.equal(hiddenLocalChild.content, "never uploaded");
  assert.deepEqual(
    db.getSpeakerMappings(child.id).map((row) => row.display_name),
    ["Alice"]
  );
  assert.equal(db.getNoteSpeakerEmbeddings(child.id).length, 1);

  const childChatTombstone = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(childNoteConv.id);
  assert.ok(childChatTombstone.deleted_at, "note-only chat is hidden with the optimistic delete");
  assert.equal(childChatTombstone.note_id, child.id);
  assert.equal(childChatTombstone.folder_id, null);
  assert.equal(childChatTombstone.sync_status, "folder_delete_pending");
  assert.equal(
    db.getAgentMessages(childNoteConv.id).length,
    1,
    "synced note-chat content remains recoverable until the folder delete is accepted"
  );
  assert.deepEqual(db.getConversationsForNote(child.id), []);
  assert.ok(db.db.prepare("SELECT id FROM agent_conversations WHERE id = ?").get(localNoteConv.id));
  assert.ok(
    db.db.prepare("SELECT id FROM agent_conversations WHERE id = ?").get(localFolderConv.id)
  );
  const optimisticTombstone = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(syncedFolderConv.id);
  assert.ok(optimisticTombstone.deleted_at);
  assert.equal(optimisticTombstone.sync_status, "folder_delete_pending");
  assert.equal(
    db.getConversationByClientId(syncedFolderConv.client_conversation_id).folder_delete_pending,
    1
  );
  assert.equal(
    db.getAgentMessages(syncedFolderConv.id).length,
    1,
    "an optimistic folder delete keeps synced messages recoverable until server acceptance"
  );
  assert.equal(db.getAgentMessages(localNoteConv.id).length, 1);
  assert.equal(db.getAgentMessages(localFolderConv.id).length, 1);
  // A late async acknowledgement may rewrite sync_status after the hold. The
  // durable journal, not that transient status, must still own both queues.
  db.db.prepare("UPDATE notes SET sync_status = 'pending' WHERE id = ?").run(child.id);
  db.db
    .prepare("UPDATE agent_conversations SET sync_status = 'pending' WHERE id = ?")
    .run(childNoteConv.id);
  assert.ok(
    !db
      .getPendingConversationDeletes()
      .some(
        (conversation) =>
          conversation.id === childNoteConv.id ||
          conversation.id === syncedFolderConv.id ||
          conversation.id === localNoteConv.id ||
          conversation.id === localFolderConv.id
      ),
    "conversation deletes wait for the folder-delete result"
  );
  assert.ok(
    db
      .getPendingConversationDeletes()
      .some((conversation) => conversation.id === alreadyDeleted.id),
    "a pre-existing conversation tombstone remains independently queued"
  );
  assert.ok(
    !db.getPendingNoteDeletes().some((note) => note.id === child.id),
    "held child notes are not individually queued for deletion"
  );
  assert.equal(db.getConversationsForContainer(space.id, null)[0].id, spaceConv.id);

  db.db.close();
  db = new DatabaseManager();
  db.setActiveAccountId("test-account");
  const restored = db.restoreFolderAfterDeniedDelete(folder.id);
  assert.equal(restored.success, true);
  assert.equal(restored.folder.id, folder.id);
  assert.deepEqual(
    db
      .getNotes(null, 100, folder.id)
      .map((note) => note.id)
      .sort((a, b) => a - b),
    [child.id, localChild.id].sort((a, b) => a - b),
    "both cloud-backed and local-only notes become visible with their original ids"
  );
  assert.equal(db.getNote(child.id).sync_status, "synced");
  assert.equal(db.getNote(localChild.id).sync_status, "pending");
  assert.equal(db.getNote(localChild.id).content, "never uploaded");
  assert.deepEqual(
    db.getConversationsForNote(child.id).map((conversation) => conversation.id),
    [childNoteConv.id]
  );
  assert.equal(
    db.db.prepare("SELECT sync_status FROM agent_conversations WHERE id = ?").get(childNoteConv.id)
      .sync_status,
    "synced",
    "rollback restores metadata captured before a late acknowledgement"
  );
  assert.deepEqual(
    db.getConversationsForNote(localChild.id).map((conversation) => conversation.id),
    [localNoteConv.id]
  );
  assert.deepEqual(
    db
      .getConversationsForContainer(space.id, folder.id)
      .map((conversation) => conversation.id)
      .sort((a, b) => a - b),
    [localFolderConv.id, syncedFolderConv.id].sort((a, b) => a - b)
  );
  assert.equal(db.getAgentConversation(childNoteConv.id).messages.length, 1);
  assert.equal(
    db.getAgentConversation(localNoteConv.id).messages[0].content,
    "local note chat survives denial"
  );
  assert.equal(
    db.getAgentConversation(localFolderConv.id).messages[0].content,
    "local folder chat survives denial"
  );
  assert.deepEqual(
    db.getSpeakerMappings(child.id).map((row) => row.display_name),
    ["Alice"]
  );
  assert.deepEqual([...db.getNoteSpeakerEmbeddings(child.id)[0].embedding], [1, 2, 3, 4]);
  assert.equal(
    db.db.prepare("SELECT deleted_at FROM agent_conversations WHERE id = ?").get(alreadyDeleted.id)
      .deleted_at !== null,
    true,
    "rollback does not revive a conversation deleted before the folder action"
  );
  assert.equal(
    db.db.prepare("SELECT sync_status FROM agent_conversations WHERE id = ?").get(alreadyDeleted.id)
      .sync_status,
    "pending"
  );
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM optimistic_folder_delete_rows WHERE folder_id = ?")
      .get(folder.id).count,
    0
  );
});

test("denied folder delete rollback reports a name clash instead of failing hard", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder = db.createFolder("Docs", space.id).folder;
  db.markFolderSynced(folder.id, "cloud-folder-held");
  const child = db.saveNote("Child", "body", "personal", null, null, folder.id).note;

  assert.equal(db.deleteFolder(folder.id).success, true);
  const journalBefore = db.db
    .prepare("SELECT COUNT(*) AS count FROM optimistic_folder_delete_rows WHERE folder_id = ?")
    .get(folder.id).count;
  assert.ok(journalBefore > 0);

  // A pull inserts a teammate's live folder reusing the held name (the pull
  // path bypasses the local name reservation, and the held row is deleted_at so
  // the partial unique index doesn't stop the insert), so the name is no longer
  // free when the server later denies the delete.
  db.upsertFolderFromCloud(
    {
      client_folder_id: "cf-remote-docs",
      id: "cloud-folder-live",
      name: "Docs",
      sort_order: 0,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-02T00:00:00.000Z",
    },
    space.id
  );

  const restored = db.restoreFolderAfterDeniedDelete(folder.id);
  assert.equal(restored.success, false);
  assert.equal(
    restored.reason,
    "name-taken",
    "a name clash is a recoverable, surfaced outcome — not a hard error the sync pass rethrows"
  );

  // The rollback transaction is atomic: a clash restores nothing, so the held
  // folder and its journal stay intact for the next pass to retry once the user
  // frees the name.
  assert.ok(db.db.prepare("SELECT deleted_at FROM folders WHERE id = ?").get(folder.id).deleted_at);
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM optimistic_folder_delete_rows WHERE folder_id = ?")
      .get(folder.id).count,
    journalBefore
  );
  assert.equal(db.getNote(child.id).sync_status, "folder_delete_pending");
});

test("confirmed folder delete scrubs chats and finalizes held rows", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = createTestTeamSpace(db, { name: "Eng" }).space;
  const folder2 = db.createFolder("Specs", space.id).folder;
  const childNote = db.saveNote(
    "Folder note",
    "sensitive body",
    "personal",
    null,
    null,
    folder2.id
  ).note;
  const noteConv = db.createAgentConversation("Note-only chat", childNote.id);
  db.markConversationSynced(noteConv.id, "cloud-conv-note");
  db.addAgentMessage(noteConv.id, "user", "note-scoped sensitive content");
  const conv2 = db.createAgentConversation("Specs chat", null, space.id, folder2.id);
  db.markConversationSynced(conv2.id, "cloud-conv-2");
  db.addAgentMessage(conv2.id, "user", "confirmed delete must scrub this");
  db.hardDeleteFolder(folder2.id);
  assert.equal(db.getNote(childNote.id), null);
  const noteTombstone = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(noteConv.id);
  assert.ok(noteTombstone.deleted_at);
  assert.equal(noteTombstone.sync_status, "pending");
  assert.equal(noteTombstone.folder_id, null, "regression fixture is scoped only by note_id");
  assert.equal(db.getAgentMessages(noteConv.id).length, 0);
  assert.deepEqual(db.getConversationsForNote(childNote.id), []);
  const tombstoned = db.db.prepare("SELECT * FROM agent_conversations WHERE id = ?").get(conv2.id);
  assert.ok(tombstoned.deleted_at);
  assert.equal(tombstoned.sync_status, "pending");
  assert.equal(
    db.getAgentMessages(conv2.id).length,
    0,
    "a confirmed hard delete scrubs synced messages"
  );

  const folder3 = db.createFolder("Accepted", space.id).folder;
  db.markFolderSynced(folder3.id, "cloud-folder-accepted");
  const acceptedLocalNote = db.saveNote(
    "Accepted local child",
    "delete after confirmation",
    "personal",
    null,
    null,
    folder3.id
  ).note;
  const acceptedLocalConv = db.createAgentConversation("Accepted local chat", acceptedLocalNote.id);
  db.addAgentMessage(acceptedLocalConv.id, "user", "local content is held until confirmation");
  const acceptedConv = db.createAgentConversation("Accepted chat", null, space.id, folder3.id);
  db.markConversationSynced(acceptedConv.id, "cloud-conv-accepted");
  db.addAgentMessage(acceptedConv.id, "user", "scrub after server acceptance");
  const acceptedPredeleted = db.createAgentConversation(
    "Accepted predeleted",
    null,
    space.id,
    folder3.id
  );
  db.markConversationSynced(acceptedPredeleted.id, "cloud-conv-predeleted");
  db.addAgentMessage(acceptedPredeleted.id, "user", "scrub but keep delete intent");
  db.deleteAgentConversation(acceptedPredeleted.id);
  assert.equal(db.deleteFolder(folder3.id).success, true);
  assert.equal(
    db.db.prepare("SELECT sync_status FROM agent_conversations WHERE id = ?").get(acceptedConv.id)
      .sync_status,
    "folder_delete_pending"
  );
  assert.equal(db.hardDeleteFolder(folder3.id).success, true);
  const acceptedTombstone = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(acceptedConv.id);
  assert.equal(acceptedTombstone.sync_status, "pending");
  assert.equal(db.getAgentMessages(acceptedConv.id).length, 0);
  assert.equal(db.getNote(acceptedLocalNote.id), null);
  assert.equal(db.getAgentConversation(acceptedLocalConv.id), null);
  const predeletedAfterConfirmation = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(acceptedPredeleted.id);
  assert.ok(predeletedAfterConfirmation.deleted_at);
  assert.equal(predeletedAfterConfirmation.sync_status, "pending");
  assert.equal(db.getAgentMessages(acceptedPredeleted.id).length, 0);
  const acceptedDeleteIds = new Set(
    db.getPendingConversationDeletes().map((conversation) => conversation.id)
  );
  assert.ok(acceptedDeleteIds.has(acceptedConv.id));
  assert.ok(acceptedDeleteIds.has(acceptedPredeleted.id));
});

test("relocateRevokedFolder moves or retires the folder's conversations", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const space = createTestTeamSpace(db, { name: "Eng" }).space;

  const kept = db.createFolder("Kept", space.id).folder;
  const keptConv = db.createAgentConversation("Kept chat", null, space.id, kept.id);
  assert.equal(db.relocateRevokedFolder(kept.id, privateId, true).success, true);
  const moved = db.db.prepare("SELECT * FROM agent_conversations WHERE id = ?").get(keptConv.id);
  assert.equal(moved.space_id, privateId, "chat follows the preserved folder");
  assert.equal(moved.deleted_at, null);

  const dropped = db.createFolder("Dropped", space.id).folder;
  const droppedConv = db.createAgentConversation("Dropped chat", null, space.id, dropped.id);
  assert.equal(db.relocateRevokedFolder(dropped.id, privateId, false).success, true);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM agent_conversations WHERE id = ?").get(droppedConv.id)
      .n,
    0
  );
});
