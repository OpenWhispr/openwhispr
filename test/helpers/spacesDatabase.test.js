const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spaces-db-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spaces-db-"));
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
    .run(`test-team-space-${++nextTestTeamSpaceId}`, name, emoji, (maxOrder?.max_order ?? 0) + 1);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(result.lastInsertRowid, "test-account");
  return { success: true, space: db.getSpace(result.lastInsertRowid) };
}

test("spaces migration is idempotent across launches", (t) => {
  const db = createDb(t);
  if (!db) return;

  const foldersSql = db.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
    .get().sql;
  assert.ok(
    !foldersSql.includes("UNIQUE"),
    "folders rebuild should drop the UNIQUE(name) constraint"
  );
  db.db.close();

  const db2 = new DatabaseManager();
  const rerunSql = db2.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
    .get().sql;
  assert.equal(rerunSql, foldersSql, "second launch must not rebuild folders again");

  const noteColumns = db2.db.pragma("table_info('notes')").map((col) => col.name);
  assert.ok(noteColumns.includes("space_id"));
  const folderColumns = db2.db.pragma("table_info('folders')").map((col) => col.name);
  assert.ok(folderColumns.includes("space_id"));

  const indexes = db2.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'folders'")
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_folders_client_folder_id"));
  assert.ok(indexes.includes("idx_folders_space_legacy_name"));
  assert.ok(indexes.includes("idx_folders_space_account_name"));

  const privates = db2.db
    .prepare("SELECT COUNT(*) as count FROM spaces WHERE kind = 'private'")
    .get();
  assert.equal(privates.count, 1);
});

test("pre-migration rows are backfilled into the private space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  assert.ok(privateId);

  for (const folder of db.getFolders()) {
    assert.equal(folder.space_id, privateId);
  }
  for (const note of db.getNotes()) {
    assert.equal(note.space_id, privateId);
  }

  // Simulate rows written before the spaces migration existed.
  db.db
    .prepare("INSERT INTO folders (name, client_folder_id) VALUES ('Legacy', 'legacy-folder')")
    .run();
  db.db
    .prepare(
      "INSERT INTO notes (title, content, client_note_id) VALUES ('Legacy', '', 'legacy-note')"
    )
    .run();
  db.db.close();

  const db2 = new DatabaseManager();
  const legacyFolder = db2.db
    .prepare("SELECT * FROM folders WHERE client_folder_id = 'legacy-folder'")
    .get();
  assert.equal(legacyFolder.space_id, privateId);
  const legacyNote = db2.db
    .prepare("SELECT * FROM notes WHERE client_note_id = 'legacy-note'")
    .get();
  assert.equal(legacyNote.space_id, privateId);
});

test("folder names are unique per space, not globally", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Design" });
  assert.ok(team.success);
  assert.equal(team.space.kind, "team");

  const inPrivate = db.createFolder("Projects");
  assert.ok(inPrivate.success);
  assert.equal(inPrivate.folder.space_id, db.getPrivateSpaceId());

  const inTeam = db.createFolder("Projects", team.space.id);
  assert.ok(inTeam.success, "same name in another space must be allowed");
  assert.equal(inTeam.folder.space_id, team.space.id);

  assert.equal(db.createFolder("Projects").success, false);
  assert.equal(db.createFolder("Projects", team.space.id).success, false);
});

test("updateNote forces space_id to follow folder_id (D2)", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Eng" }).space;
  const teamFolder = db.createFolder("Docs", team.id).folder;

  const { note } = db.saveNote("Move me", "content");
  assert.equal(note.space_id, privateId);

  const moved = db.updateNote(note.id, { folder_id: teamFolder.id, space_id: privateId });
  assert.equal(moved.note.folder_id, teamFolder.id);
  assert.equal(moved.note.space_id, team.id, "folder's space must win over an explicit space_id");

  const detached = db.updateNote(note.id, { folder_id: null, space_id: privateId });
  assert.equal(detached.note.folder_id, null);
  assert.equal(detached.note.space_id, privateId);

  const retitled = db.updateNote(note.id, { title: "kept" });
  assert.equal(
    retitled.note.space_id,
    privateId,
    "space must not change without folder/space updates"
  );
});

test("purgeSpace leaves zero residue for the space and spares the private space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Secret" }).space;
  const teamFolder = db.createFolder("Vault", team.id).folder;

  const teamNote = db.saveNote(
    "Team plan",
    "classified zebracorn intel",
    "personal",
    null,
    null,
    teamFolder.id
  ).note;
  assert.equal(teamNote.space_id, team.id);
  db.markNoteSynced(teamNote.id, "cloud-team-note");
  const draft = db.saveNote(
    "Draft",
    "unsent yeti prose",
    "personal",
    null,
    null,
    teamFolder.id
  ).note;
  const privateNote = db.saveNote("Mine", "private groundhog data").note;

  const seedMapping = db.db.prepare(
    "INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, ?, ?)"
  );
  const seedEmbedding = db.db.prepare(
    "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
  );
  for (const note of [teamNote, privateNote]) {
    seedMapping.run(note.id, "spk_0", "Alice");
    seedEmbedding.run(note.id, "spk_0", Buffer.from(new Float32Array([0.1, 0.2]).buffer));
  }

  const result = db.purgeSpace(team.id);
  assert.ok(result.success);
  assert.deepEqual(result.noteIds, [teamNote.id]);
  assert.deepEqual(result.folderNames, ["Vault"]);
  assert.equal(result.spaceId, team.id);

  // Never-synced notes exist nowhere else — relocated, not destroyed.
  assert.equal(result.relocatedCount, 1);
  assert.deepEqual(result.relocatedTitles, ["Draft"]);
  assert.deepEqual(
    result.relocatedNotes.map((n) => n.id),
    [draft.id]
  );
  const relocated = db.getNote(draft.id);
  assert.equal(relocated.space_id, privateId);
  assert.equal(relocated.folder_id, null);
  assert.equal(relocated.sync_status, "pending");

  const count = (sql, ...args) => db.db.prepare(sql).get(...args).count;
  assert.equal(count("SELECT COUNT(*) as count FROM notes WHERE space_id = ?", team.id), 0);
  assert.equal(count("SELECT COUNT(*) as count FROM folders WHERE space_id = ?", team.id), 0);
  assert.equal(count("SELECT COUNT(*) as count FROM spaces WHERE id = ?", team.id), 0);
  assert.equal(
    count("SELECT COUNT(*) as count FROM speaker_mappings WHERE note_id = ?", teamNote.id),
    0
  );
  assert.equal(
    count("SELECT COUNT(*) as count FROM note_speaker_embeddings WHERE note_id = ?", teamNote.id),
    0
  );
  assert.equal(
    count("SELECT COUNT(*) as count FROM notes_fts WHERE notes_fts MATCH 'zebracorn'"),
    0
  );
  assert.equal(count("SELECT COUNT(*) as count FROM notes_fts WHERE notes_fts MATCH 'yeti'"), 1);

  assert.equal(count("SELECT COUNT(*) as count FROM notes WHERE space_id = ?", privateId), 2);
  assert.equal(
    count("SELECT COUNT(*) as count FROM speaker_mappings WHERE note_id = ?", privateNote.id),
    1
  );
  assert.equal(
    count("SELECT COUNT(*) as count FROM notes_fts WHERE notes_fts MATCH 'groundhog'"),
    1
  );

  const refused = db.purgeSpace(privateId);
  assert.equal(refused.success, false);
  assert.equal(count("SELECT COUNT(*) as count FROM spaces WHERE id = ?", privateId), 1);
});

test("purgeSpace retires team-note chats and preserves chats for relocated drafts", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Secret" }).space;
  const folder = db.createFolder("Vault", team.id).folder;

  const clean = db.saveNote("Team plan", "server copy", "personal", null, null, folder.id).note;
  db.markNoteSynced(clean.id, "cloud-note-1");
  const localChat = db.createAgentConversation("Local team chat", clean.id);
  db.addAgentMessage(localChat.id, "user", "local classified chat");
  const syncedChat = db.createAgentConversation("Synced team chat", clean.id);
  db.markConversationSynced(syncedChat.id, "cloud-conversation-1");
  db.addAgentMessage(syncedChat.id, "assistant", "synced classified chat");

  const draft = db.saveNote("Draft", "unpushed work", "personal", null, null, folder.id).note;
  // Exercise defensive normalization for a legacy note chat that also carries
  // redundant team-container scope.
  const draftChat = db.createAgentConversation("Draft chat", draft.id, team.id, folder.id);
  db.addAgentMessage(draftChat.id, "user", "keep with my draft");

  const privateNote = db.saveNote("Mine", "personal").note;
  const privateChat = db.createAgentConversation("Private chat", privateNote.id);
  db.addAgentMessage(privateChat.id, "user", "keep private");

  db.markFolderSynced(folder.id, "cloud-folder-revoked-during-delete");
  assert.equal(db.deleteFolder(folder.id).success, true);
  assert.equal(db.purgeSpace(team.id).success, true);

  const count = (sql, ...args) => db.db.prepare(sql).get(...args).count;
  assert.equal(
    count("SELECT COUNT(*) AS count FROM agent_conversations WHERE id = ?", localChat.id),
    0,
    "a never-synced team-note chat has no cloud row to retire"
  );
  assert.equal(
    count("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?", localChat.id),
    0
  );

  const tombstone = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(syncedChat.id);
  assert.ok(tombstone.deleted_at, "a synced team-note chat leaves a cloud delete tombstone");
  assert.equal(tombstone.sync_status, "pending");
  assert.equal(
    count("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?", syncedChat.id),
    0,
    "team chat content is removed even while its cloud delete is pending"
  );
  assert.deepEqual(db.getConversationsForNote(clean.id), []);
  assert.ok(!db.getAgentConversations().some((conversation) => conversation.id === syncedChat.id));

  const relocatedDraft = db.getNote(draft.id);
  assert.equal(relocatedDraft.space_id, privateId);
  assert.equal(relocatedDraft.folder_id, null);
  const keptDraftChat = db.getAgentConversation(draftChat.id);
  assert.equal(keptDraftChat.note_id, draft.id);
  assert.equal(keptDraftChat.space_id, null);
  assert.equal(keptDraftChat.folder_id, null);
  assert.equal(keptDraftChat.deleted_at, null);
  assert.equal(keptDraftChat.messages.length, 1);

  assert.equal(db.getAgentConversation(privateChat.id).messages.length, 1);
});

test("purgeSpace destructive mode removes dirty team notes and chats without relocation", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Old account" }).space;
  const folder = db.createFolder("Secrets", team.id).folder;

  const dirty = db.saveNote(
    "Pending team edit",
    "old-account content",
    "personal",
    null,
    null,
    folder.id
  ).note;
  db.markNoteSynced(
    dirty.id,
    "cloud-dirty-account-note",
    "2026-07-29T10:00:00.000Z",
    "old-account-user"
  );
  db.updateNote(dirty.id, { content: "old-account content edited offline" });
  assert.equal(db.getNote(dirty.id).sync_status, "pending");

  const noteChat = db.createAgentConversation("Old account note chat", dirty.id);
  db.markConversationSynced(noteChat.id, "cloud-old-account-note-chat");
  db.addAgentMessage(noteChat.id, "user", "old-account private message");
  const containerChat = db.createAgentConversation(
    "Old account folder chat",
    null,
    team.id,
    folder.id
  );
  db.markConversationSynced(containerChat.id, "cloud-old-account-folder-chat");
  db.addAgentMessage(containerChat.id, "assistant", "old-account scoped response");
  db.markFolderSynced(folder.id, "cloud-old-account-folder");
  assert.equal(db.deleteFolder(folder.id).success, true);
  assert.ok(
    db.db
      .prepare(
        "SELECT 1 FROM optimistic_folder_delete_rows WHERE folder_id = ? AND entity_type = 'folder'"
      )
      .get(folder.id),
    "fixture includes an unresolved optimistic folder delete"
  );

  const privateNote = db.saveNote("Device note", "keep local device content").note;
  const privateChat = db.createAgentConversation("Device chat", privateNote.id);
  db.addAgentMessage(privateChat.id, "user", "keep this message");

  const result = db.purgeSpace(team.id, { mode: "destructive" });
  assert.equal(result.success, true);
  assert.deepEqual(result.noteIds, [dirty.id]);
  assert.equal(result.relocatedCount, 0);
  assert.deepEqual(result.relocatedNotes, []);

  const count = (sql, ...args) => db.db.prepare(sql).get(...args).count;
  assert.equal(count("SELECT COUNT(*) AS count FROM notes WHERE id = ?", dirty.id), 0);
  assert.equal(
    count("SELECT COUNT(*) AS count FROM notes WHERE space_id = ?", privateId),
    1,
    "a dirty team note must not fork into Personal during an account transition"
  );
  for (const conversation of [noteChat, containerChat]) {
    assert.equal(
      count("SELECT COUNT(*) AS count FROM agent_conversations WHERE id = ?", conversation.id),
      0,
      "even a synced chat must be hard-deleted rather than left as a cloud-delete tombstone"
    );
    assert.equal(
      count(
        "SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?",
        conversation.id
      ),
      0
    );
  }
  assert.equal(db.getAgentConversation(privateChat.id).messages.length, 1);
  assert.equal(
    count(
      "SELECT COUNT(*) AS count FROM optimistic_folder_delete_rows WHERE folder_id = ?",
      folder.id
    ),
    0,
    "account-destructive purge clears rollback metadata"
  );

  // A late editor flush is UPDATE-only. Once destructive purge commits, it
  // cannot recreate the deleted note under Personal or any other space.
  const lateSave = db.updateNote(dirty.id, {
    title: "Late old-account save",
    content: "must not reappear",
  });
  assert.equal(lateSave.note, undefined);
  assert.equal(count("SELECT COUNT(*) AS count FROM notes WHERE id = ?", dirty.id), 0);
  assert.equal(count("SELECT COUNT(*) AS count FROM notes WHERE space_id = ?", privateId), 1);
});

test("saveNote resolves default folders within the target space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Ops" }).space;
  db.db
    .prepare(
      "INSERT INTO folders (name, is_default, sort_order, space_id, client_folder_id) VALUES ('Meetings', 1, 0, ?, 'team-meetings')"
    )
    .run(team.id);

  const privateMeetingsFolder = db.getMeetingsFolder();
  const teamMeetingsFolder = db.getMeetingsFolder(team.id);
  assert.ok(privateMeetingsFolder);
  assert.ok(teamMeetingsFolder);
  assert.notEqual(teamMeetingsFolder.id, privateMeetingsFolder.id);

  const privateMeeting = db.saveNote("Standup", "notes", "meeting").note;
  assert.equal(privateMeeting.folder_id, privateMeetingsFolder.id);
  assert.equal(privateMeeting.space_id, privateId);

  const teamMeeting = db.saveNote("Sync", "notes", "meeting", null, null, null, team.id).note;
  assert.equal(teamMeeting.folder_id, teamMeetingsFolder.id);
  assert.equal(teamMeeting.space_id, team.id);

  // No matching default folder in the team space → note keeps the space, no folder.
  const teamDoc = db.saveNote("Doc", "body", "personal", null, null, null, team.id).note;
  assert.equal(teamDoc.folder_id, null);
  assert.equal(teamDoc.space_id, team.id);
});

test("moveFolderToSpace moves the folder and its live notes in one transaction", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Growth" }).space;
  const folder = db.createFolder("Campaigns").folder;
  const filed = db.saveNote("Plan", "body", "personal", null, null, folder.id).note;
  const loose = db.saveNote("Loose", "body").note;

  const moved = db.moveFolderToSpace(folder.id, team.id);
  assert.ok(moved.success);
  assert.equal(moved.folder.space_id, team.id);
  assert.equal(moved.folder.sync_status, "pending");
  assert.deepEqual(
    moved.notes.map((n) => n.id),
    [filed.id]
  );

  const movedNote = db.getNote(filed.id);
  assert.equal(movedNote.space_id, team.id);
  assert.equal(movedNote.folder_id, folder.id, "notes keep their folder link");
  assert.equal(movedNote.sync_status, "pending");
  assert.equal(db.getNote(loose.id).space_id, privateId, "notes outside the folder stay put");

  const duplicate = db.createFolder("Campaigns").folder;
  assert.equal(
    db.moveFolderToSpace(duplicate.id, team.id).success,
    false,
    "a same-named folder in the target space blocks the move"
  );

  const meetings = db.getMeetingsFolder();
  assert.equal(db.moveFolderToSpace(meetings.id, team.id).success, false);
});

test("getNotes with spaceId and no folderId lists only the space's root notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Ops" }).space;
  const folder = db.createFolder("Docs", team.id).folder;
  const rootNote = db.saveNote("Root", "body", "personal", null, null, null, team.id).note;
  db.saveNote("Filed", "body", "personal", null, null, folder.id);

  const rootNotes = db.getNotes(null, 50, null, team.id);
  assert.deepEqual(
    rootNotes.map((n) => n.id),
    [rootNote.id]
  );

  const folderNotes = db.getNotes(null, 50, folder.id);
  assert.equal(folderNotes.length, 1);
  assert.equal(folderNotes[0].title, "Filed");
});

test("pending queues split by space kind", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Sales" }).space;
  const privateFolder = db.createFolder("Ideas").folder;
  const teamFolder = db.createFolder("Pipeline", team.id).folder;
  const privateNote = db.saveNote("Mine", "body").note;
  const teamNote = db.saveNote("Ours", "body", "personal", null, null, null, team.id).note;

  assert.deepEqual(
    db.getPendingNotes("team").map((n) => n.id),
    [teamNote.id]
  );
  assert.ok(db.getPendingNotes("private").some((n) => n.id === privateNote.id));
  assert.ok(!db.getPendingNotes("private").some((n) => n.id === teamNote.id));
  assert.equal(
    db.getPendingNotes().length,
    db.getPendingNotes("private").length + db.getPendingNotes("team").length
  );

  assert.deepEqual(
    db.getPendingFolders("team").map((f) => f.id),
    [teamFolder.id]
  );
  assert.ok(db.getPendingFolders("private").some((f) => f.id === privateFolder.id));
  assert.equal(
    db.getPendingFolders().length,
    db.getPendingFolders("private").length + db.getPendingFolders("team").length
  );
});

test("space-root notes keep folder_id NULL across relaunches", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Team" }).space;
  const teamRoot = db.saveNote("Team root", "body", "personal", null, null, null, team.id).note;
  assert.equal(teamRoot.folder_id, null);
  const privateRoot = db.saveNote("Mine", "body").note;
  db.updateNote(privateRoot.id, { folder_id: null, space_id: privateId });
  db.db
    .prepare("UPDATE notes SET sync_status = 'synced' WHERE id IN (?, ?)")
    .run(teamRoot.id, privateRoot.id);
  const snapshot = db.db
    .prepare(
      "SELECT id, folder_id, space_id, sync_status, updated_at FROM notes WHERE id IN (?, ?) ORDER BY id"
    )
    .all(teamRoot.id, privateRoot.id);
  db.db.close();

  const db2 = new DatabaseManager();
  const relaunched = db2.db
    .prepare(
      "SELECT id, folder_id, space_id, sync_status, updated_at FROM notes WHERE id IN (?, ?) ORDER BY id"
    )
    .all(teamRoot.id, privateRoot.id);
  assert.deepEqual(
    relaunched,
    snapshot,
    "relaunch must not backfill space-root notes into a folder"
  );
  for (const note of relaunched) {
    assert.equal(note.folder_id, null);
  }
});

test("hard deletes clean speaker rows", (t) => {
  const db = createDb(t);
  if (!db) return;
  const seedSpeakerRows = (noteId) => {
    db.db
      .prepare(
        "INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, 'spk_0', 'Alice')"
      )
      .run(noteId);
    db.db
      .prepare(
        "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, 'spk_0', ?)"
      )
      .run(noteId, Buffer.from(new Float32Array([0.1, 0.2]).buffer));
  };
  const residue = (noteId) =>
    db.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM speaker_mappings WHERE note_id = ?) + (SELECT COUNT(*) FROM note_speaker_embeddings WHERE note_id = ?) as count"
      )
      .get(noteId, noteId).count;

  const solo = db.saveNote("Solo", "body").note;
  seedSpeakerRows(solo.id);
  assert.ok(db.hardDeleteNote(solo.id).success);
  assert.equal(residue(solo.id), 0);

  const hardFolder = db.createFolder("Hard").folder;
  const hardNote = db.saveNote("Filed", "body", "personal", null, null, hardFolder.id).note;
  seedSpeakerRows(hardNote.id);
  assert.ok(db.hardDeleteFolder(hardFolder.id).success);
  assert.equal(residue(hardNote.id), 0);

  const softFolder = db.createFolder("Soft").folder;
  const softNote = db.saveNote("Filed too", "body", "personal", null, null, softFolder.id).note;
  seedSpeakerRows(softNote.id);
  assert.ok(db.deleteFolder(softFolder.id).success);
  assert.equal(residue(softNote.id), 0);
});

test("upsertFolderFromCloud converges on a same-space name collision", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Shared" }).space;
  const local = db.createFolder("Projects", team.id).folder;

  const cloud = {
    client_folder_id: "cf-remote",
    id: "cloud-folder-1",
    name: "Projects",
    sort_order: 7,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
  };
  const converged = db.upsertFolderFromCloud(cloud, team.id);
  assert.equal(converged.id, local.id, "must adopt the existing live folder, not insert");
  assert.equal(converged.client_folder_id, "cf-remote");
  assert.equal(converged.cloud_id, "cloud-folder-1");
  assert.equal(converged.sort_order, 7);
  assert.equal(converged.name, "Projects");
  assert.equal(converged.sync_status, "synced");
  assert.equal(db.getFolders(team.id).filter((f) => f.name === "Projects").length, 1);

  // DO UPDATE branch: the cloud folder is renamed to a name held by another
  // live local folder in the same space — the holder adopts the identity and
  // the stale tracker is forked instead of wedging the pull.
  const other = db.createFolder("Roadmap", team.id).folder;
  const renamed = db.upsertFolderFromCloud(
    { ...cloud, name: "Roadmap", updated_at: "2026-07-03T00:00:00.000Z" },
    team.id
  );
  assert.equal(renamed.id, other.id);
  assert.equal(renamed.client_folder_id, "cf-remote");
  assert.equal(renamed.cloud_id, "cloud-folder-1");
  const forked = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(local.id);
  assert.notEqual(forked.client_folder_id, "cf-remote");
  assert.equal(forked.cloud_id, null);
  assert.equal(forked.sync_status, "pending");
});

test("pending vector purges persist across relaunches until cleared", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.addPendingVectorPurge(42);
  db.addPendingVectorPurge(42);
  db.addPendingVectorPurge(7);
  assert.deepEqual(
    db
      .getPendingVectorPurges()
      .map((row) => row.space_id)
      .sort((a, b) => a - b),
    [7, 42]
  );
  db.db.close();

  const db2 = new DatabaseManager();
  assert.equal(db2.getPendingVectorPurges().length, 2, "queue must survive a relaunch");
  db2.clearPendingVectorPurge(42);
  assert.deepEqual(
    db2.getPendingVectorPurges().map((row) => row.space_id),
    [7]
  );
});

test("setSpaceSyncStatus flips a space's sync_status", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Docs" }).space;

  const settled = db.setSpaceSyncStatus(team.id, "synced");
  assert.ok(settled.success);
  assert.equal(settled.space.id, team.id);
  assert.equal(settled.space.sync_status, "synced");
  assert.equal(db.getSpaces().find((s) => s.id === team.id).sync_status, "synced");

  assert.ok(db.setSpaceSyncStatus(team.id, "pending").success);
  assert.equal(db.getSpaces().find((s) => s.id === team.id).sync_status, "pending");

  assert.equal(db.setSpaceSyncStatus(99999, "synced").success, false);
});

test("team→private moves set left_team so retractions stay in the team queue", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Sales" }).space;

  const note = db.saveNote("Comp review", "body", "personal", null, null, null, team.id).note;
  db.markNoteSynced(note.id, "cloud-note-1");
  db.updateNote(note.id, { space_id: privateId, folder_id: null });

  const moved = db.getNote(note.id);
  assert.equal(moved.space_id, privateId);
  assert.equal(moved.left_team, 1);
  assert.equal(moved.sync_status, "pending");
  assert.ok(
    db.getPendingNotes("team").some((n) => n.id === note.id),
    "the retraction must push even in the backup-off team-only pass"
  );

  db.markNoteSynced(note.id, "cloud-note-1");
  assert.equal(db.getNote(note.id).left_team, 0, "settling clears the flag");

  // Identity forks null the cloud_id — nothing to retract, no flag.
  const forked = db.saveNote("Stub", "body", "personal", null, null, null, team.id).note;
  db.markNoteSynced(forked.id, "cloud-note-2");
  db.updateNote(forked.id, {
    space_id: privateId,
    folder_id: null,
    client_note_id: "forked-client-id",
    cloud_id: null,
  });
  assert.equal(db.getNote(forked.id).left_team, 0);

  // Never-synced rows have no server copy to retract.
  const local = db.saveNote("Local", "body", "personal", null, null, null, team.id).note;
  db.updateNote(local.id, { space_id: privateId, folder_id: null });
  assert.equal(db.getNote(local.id).left_team, 0);
  assert.ok(!db.getPendingNotes("team").some((n) => n.id === local.id));
});

test("moveFolderToSpace team→private flags the folder and its cloud-backed notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Growth" }).space;
  const folder = db.createFolder("Campaigns", team.id).folder;
  db.markFolderSynced(folder.id, "cloud-folder-1");
  const cloudNote = db.saveNote("Plan", "body", "personal", null, null, folder.id).note;
  db.markNoteSynced(cloudNote.id, "cloud-note-1");
  const localNote = db.saveNote("Draft", "body", "personal", null, null, folder.id).note;

  assert.ok(db.moveFolderToSpace(folder.id, privateId).success);
  const movedFolder = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.equal(movedFolder.left_team, 1);
  assert.equal(db.getNote(cloudNote.id).left_team, 1);
  assert.equal(db.getNote(localNote.id).left_team, 0);
  assert.ok(db.getPendingFolders("team").some((f) => f.id === folder.id));
  assert.ok(db.getPendingNotes("team").some((n) => n.id === cloudNote.id));
  assert.ok(!db.getPendingNotes("team").some((n) => n.id === localNote.id));

  // Moving back into a team clears the flags: the team queue covers the rows
  // by their space kind again.
  assert.ok(db.moveFolderToSpace(folder.id, team.id).success);
  assert.equal(
    db.db.prepare("SELECT left_team FROM folders WHERE id = ?").get(folder.id).left_team,
    0
  );
  assert.equal(db.getNote(cloudNote.id).left_team, 0);
});

test("markNoteSyncedIfUnchanged settles an exact identity and push snapshot", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Doc", "v1").note;
  db.markNoteSynced(note.id, "cloud-1", "2026-07-29T08:00:00.000Z", "owner-1");
  db.updateNote(note.id, { content: "v2" });
  const snapshot = db.getNote(note.id);

  const settled = db.markNoteSyncedIfUnchanged(
    note.id,
    snapshot,
    "cloud-1",
    "2026-07-29T09:00:00.000Z",
    "owner-1"
  );
  assert.equal(settled.outcome, "synced");
  assert.equal(settled.changes, 1);
  assert.equal(db.getNote(note.id).sync_status, "synced");
  assert.equal(db.getNote(note.id).cloud_id, "cloud-1");
  assert.equal(db.getNote(note.id).cloud_updated_at, "2026-07-29T09:00:00.000Z");
});

test("markNoteSyncedIfUnchanged keeps a same-second newer edit pending and advances its base", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Doc", "v1").note;
  db.markNoteSynced(note.id, "cloud-1", "2026-07-29T08:00:00.000Z", "owner-1");
  db.updateNote(note.id, { content: "v2" });
  const snapshot = db.getNote(note.id);

  // Do not touch updated_at: SQLite timestamps have second precision, so the
  // full pushed snapshot—not the timestamp—must detect this newer edit.
  db.db
    .prepare("UPDATE notes SET content = 'v3', sync_status = 'pending' WHERE id = ?")
    .run(note.id);
  const stale = db.markNoteSyncedIfUnchanged(
    note.id,
    snapshot,
    "cloud-1",
    "2026-07-29T09:00:00.000Z",
    "owner-2"
  );
  assert.equal(stale.outcome, "pending");
  assert.equal(stale.changes, 0);
  const current = db.getNote(note.id);
  assert.equal(current.content, "v3");
  assert.equal(current.sync_status, "pending", "the mid-flight edit must still push");
  assert.equal(current.cloud_id, "cloud-1");
  assert.equal(current.cloud_updated_at, "2026-07-29T09:00:00.000Z");
  assert.equal(current.owner_user_id, "owner-2");

  // Reverting the local content to the first request's bytes does not make a
  // late, older response safe to settle: the newer base proves PATCH 2 may be
  // what the server currently stores.
  db.db
    .prepare("UPDATE notes SET content = ?, sync_status = 'pending', updated_at = ? WHERE id = ?")
    .run(snapshot.content, snapshot.updated_at, note.id);
  const late = db.markNoteSyncedIfUnchanged(
    note.id,
    snapshot,
    "cloud-1",
    "2026-07-29T08:30:00.000Z",
    "owner-2"
  );
  assert.equal(late.outcome, "pending");
  assert.equal(db.getNote(note.id).sync_status, "pending");
  assert.equal(
    db.getNote(note.id).cloud_updated_at,
    "2026-07-29T09:00:00.000Z",
    "an out-of-order response must not regress the newer server base"
  );
});

test("markNoteSyncedIfUnchanged rejects a late PATCH response after an in-place identity fork", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Team draft", "v1").note;
  db.markNoteSynced(note.id, "team-cloud-id", "2026-07-29T08:00:00.000Z", "team-owner");
  db.updateNote(note.id, { content: "unpushed team edit" });
  const teamSnapshot = db.getNote(note.id);

  db.updateNote(note.id, {
    content: "Personal fork",
    client_note_id: "personal-fork-client-id",
    cloud_id: null,
    cloud_updated_at: null,
    owner_user_id: null,
    updated_by_user_id: null,
  });
  const forked = db.getNote(note.id);
  const rejected = db.markNoteSyncedIfUnchanged(
    note.id,
    teamSnapshot,
    "team-cloud-id",
    "2026-07-29T09:00:00.000Z",
    "team-owner"
  );

  assert.equal(rejected.outcome, "identity-changed");
  assert.equal(rejected.changes, 0);
  const afterResponse = db.getNote(note.id);
  assert.equal(afterResponse.client_note_id, forked.client_note_id);
  assert.equal(afterResponse.content, "Personal fork");
  assert.equal(afterResponse.cloud_id, null);
  assert.equal(afterResponse.cloud_updated_at, null);
  assert.equal(afterResponse.owner_user_id, null);
  assert.equal(afterResponse.sync_status, "pending");
});

test("acknowledgeNoteCreate settles only the exact create snapshot", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Doc", "v1").note;

  const settled = db.acknowledgeNoteCreate(
    note.id,
    note,
    "cloud-create-1",
    "2026-07-29T10:00:00.000Z",
    "owner-1"
  );
  assert.equal(settled.outcome, "synced");
  assert.deepEqual(
    {
      cloud_id: db.getNote(note.id).cloud_id,
      cloud_updated_at: db.getNote(note.id).cloud_updated_at,
      owner_user_id: db.getNote(note.id).owner_user_id,
      sync_status: db.getNote(note.id).sync_status,
    },
    {
      cloud_id: "cloud-create-1",
      cloud_updated_at: "2026-07-29T10:00:00.000Z",
      owner_user_id: "owner-1",
      sync_status: "synced",
    }
  );
  const ambiguous = db.acknowledgeNoteCreate(
    note.id,
    note,
    "different-cloud-id",
    "2026-07-29T10:01:00.000Z",
    "owner-1"
  );
  assert.equal(ambiguous.outcome, "unresolved");
  assert.equal(
    db.getNote(note.id).cloud_id,
    "cloud-create-1",
    "an ambiguous response must not replace or delete the adopted identity"
  );

  const racing = db.saveNote("Racing", "v1").note;
  // Keep updated_at identical to the request snapshot: the acknowledgement
  // must compare pushed fields too, because SQLite timestamps have only
  // second precision and two edits can otherwise look unchanged.
  db.db
    .prepare("UPDATE notes SET content = 'v2', sync_status = 'pending' WHERE id = ?")
    .run(racing.id);
  const pending = db.acknowledgeNoteCreate(
    racing.id,
    racing,
    "cloud-create-2",
    "2026-07-29T11:00:00.000Z",
    "owner-2"
  );
  const afterRace = db.getNote(racing.id);
  assert.equal(pending.outcome, "pending");
  assert.equal(afterRace.content, "v2");
  assert.equal(afterRace.cloud_id, "cloud-create-2", "the next PATCH must target the created row");
  assert.equal(afterRace.cloud_updated_at, "2026-07-29T11:00:00.000Z");
  assert.equal(afterRace.owner_user_id, "owner-2");
  assert.equal(afterRace.sync_status, "pending", "the intervening edit must still push");

  const partial = db.saveNote("Migration", "body").note;
  const partialAck = db.acknowledgeNoteCreate(
    partial.id,
    partial,
    "migration-cloud-id",
    "2026-07-29T11:30:00.000Z",
    null,
    false
  );
  const afterPartial = db.getNote(partial.id);
  assert.equal(partialAck.outcome, "pending");
  assert.equal(afterPartial.cloud_id, "migration-cloud-id");
  assert.equal(
    afterPartial.sync_status,
    "pending",
    "a partial migration create must still receive a full PATCH"
  );

  const recreated = db.saveNote("Fork", "local copy").note;
  db.markNoteSynced(recreated.id, "old-cloud-id", "2026-07-28T09:00:00.000Z", "old-owner");
  db.updateNote(recreated.id, {
    client_note_id: "forked-client-note-id",
    cloud_id: null,
    sync_status: "pending",
  });
  const forkSnapshot = db.getNote(recreated.id);
  assert.equal(forkSnapshot.cloud_updated_at, "2026-07-28T09:00:00.000Z");
  assert.equal(forkSnapshot.owner_user_id, "old-owner");

  const recreatedAck = db.acknowledgeNoteCreate(
    recreated.id,
    forkSnapshot,
    "new-cloud-id",
    null,
    null
  );
  const afterRecreate = db.getNote(recreated.id);
  assert.equal(recreatedAck.outcome, "synced");
  assert.equal(afterRecreate.cloud_id, "new-cloud-id");
  assert.equal(
    afterRecreate.cloud_updated_at,
    null,
    "a null create base must clear the old identity's revision"
  );
  assert.equal(
    afterRecreate.owner_user_id,
    null,
    "a null create owner must clear the old identity's owner"
  );
});

test("acknowledgeNoteCreate never mutates an identity forked by purgeSpace", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Create race" }).space;
  const note = db.saveNote("Draft", "team work", "personal", null, null, null, team.id).note;
  const originalClientNoteId = note.client_note_id;

  const purge = db.purgeSpace(team.id);
  assert.equal(purge.success, true);
  const forked = db.getNote(note.id);
  assert.notEqual(forked.client_note_id, originalClientNoteId);
  assert.equal(forked.space_id, db.getPrivateSpaceId());

  const ack = db.acknowledgeNoteCreate(
    note.id,
    note,
    "stale-team-cloud-id",
    "2026-07-29T12:00:00.000Z",
    "owner-3"
  );
  const afterAck = db.getNote(note.id);
  assert.equal(ack.outcome, "orphaned", "the caller may delete the stale cloud create");
  assert.equal(afterAck.client_note_id, forked.client_note_id);
  assert.equal(afterAck.cloud_id, null);
  assert.equal(afterAck.owner_user_id, null);
  assert.equal(afterAck.space_id, db.getPrivateSpaceId());
  assert.equal(afterAck.sync_status, "pending");
});

test("acknowledgeNoteCreate queues a team-to-Personal move for scope retraction", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Move race" }).space;
  const note = db.saveNote("Draft", "team work", "personal", null, null, null, team.id).note;

  db.updateNote(note.id, { space_id: db.getPrivateSpaceId(), folder_id: null });
  const ack = db.acknowledgeNoteCreate(
    note.id,
    note,
    "team-cloud-id",
    "2026-07-29T13:00:00.000Z",
    "owner-4"
  );
  const moved = db.getNote(note.id);
  assert.equal(ack.outcome, "pending");
  assert.equal(moved.cloud_id, "team-cloud-id");
  assert.equal(moved.left_team, 1);
  assert.ok(
    db.getPendingNotes("team").some((candidate) => candidate.id === note.id),
    "the retraction must push even when personal backup is disabled"
  );
});

test("cloud_updated_at follows the pull, edit, push, and conflict lifecycle", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const firstCloudRevision = "2026-07-20T10:00:00.000Z";
  const pushedCloudRevision = "2026-07-20T11:00:00.000Z";
  const conflictCloudRevision = "2026-07-20T12:00:00.000Z";

  const pulled = db.upsertNoteFromCloud(
    {
      id: "cloud-lifecycle-1",
      client_note_id: "client-lifecycle-1",
      title: "Lifecycle",
      content: "cloud v1",
      created_at: firstCloudRevision,
      updated_at: firstCloudRevision,
    },
    null,
    privateId
  );
  assert.equal(pulled.cloud_updated_at, firstCloudRevision, "pull establishes the PATCH base");

  db.updateNote(pulled.id, { content: "local v2" });
  const pushSnapshot = db.getNote(pulled.id);
  assert.equal(pushSnapshot.sync_status, "pending");
  assert.equal(
    pushSnapshot.cloud_updated_at,
    firstCloudRevision,
    "local edits preserve the last observed server revision"
  );

  const settled = db.markNoteSyncedIfUnchanged(
    pulled.id,
    pushSnapshot,
    pulled.cloud_id,
    pushedCloudRevision
  );
  assert.equal(settled.changes, 1);
  assert.equal(db.getNote(pulled.id).sync_status, "synced");
  assert.equal(db.getNote(pulled.id).cloud_updated_at, pushedCloudRevision);

  db.updateNote(pulled.id, { content: "local v3" });
  const racingSnapshot = db.getNote(pulled.id);
  db.db
    .prepare(
      "UPDATE notes SET content = 'local v4', sync_status = 'pending', updated_at = datetime('now', '+1 hour') WHERE id = ?"
    )
    .run(pulled.id);
  const raced = db.markNoteSyncedIfUnchanged(
    pulled.id,
    racingSnapshot,
    pulled.cloud_id,
    conflictCloudRevision
  );
  assert.equal(raced.changes, 0);
  assert.equal(db.getNote(pulled.id).sync_status, "pending");
  assert.equal(
    db.getNote(pulled.id).cloud_updated_at,
    conflictCloudRevision,
    "a delivered PATCH advances the base even when a newer local edit stays pending"
  );

  db.setNoteCloudBase(pulled.id, "2026-07-20T13:00:00.000Z");
  assert.equal(db.getNote(pulled.id).sync_status, "pending");
  assert.equal(db.getNote(pulled.id).cloud_updated_at, "2026-07-20T13:00:00.000Z");

  db.markNoteSynced(pulled.id, "forked-cloud-id", null);
  assert.equal(
    db.getNote(pulled.id).cloud_updated_at,
    null,
    "a fork recreated under a new cloud id cannot retain the old row's base"
  );
});

test("markFolderSyncedIfUnchanged compares the full pushed folder snapshot", (t) => {
  const db = createDb(t);
  if (!db) return;
  const folder = db.createFolder("Design").folder;
  const readFolder = () => db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  db.markFolderSynced(folder.id, "cloud-folder-1");
  db.renameFolder(folder.id, "Design queued");
  const exactSnapshot = readFolder();

  const settled = db.markFolderSyncedIfUnchanged(folder.id, exactSnapshot, "cloud-folder-1");
  assert.equal(settled.outcome, "synced");
  assert.equal(settled.changes, 1);
  assert.equal(readFolder().sync_status, "synced");
  assert.equal(readFolder().cloud_id, "cloud-folder-1");

  db.renameFolder(folder.id, "Design v2");
  const racingSnapshot = readFolder();
  // Simulate a second rename landing in the same SQLite timestamp tick while
  // the PATCH is in flight. Timestamp-only guards cannot distinguish this.
  db.db
    .prepare("UPDATE folders SET name = 'Design v3', sync_status = 'pending' WHERE id = ?")
    .run(folder.id);
  assert.equal(readFolder().updated_at, racingSnapshot.updated_at);
  const stale = db.markFolderSyncedIfUnchanged(folder.id, racingSnapshot, "cloud-folder-1");
  assert.equal(stale.outcome, "pending");
  assert.equal(stale.changes, 0);
  assert.equal(readFolder().sync_status, "pending", "the mid-flight rename must still push");
  assert.equal(readFolder().name, "Design v3");
});

test("folder PATCH acknowledgement never mutates an in-place revocation fork", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Folder PATCH race" }).space;
  const folder = db.createFolder("Team designs", team.id).folder;
  db.markFolderSynced(folder.id, "old-cloud-folder");
  db.renameFolder(folder.id, "Team designs queued");
  const snapshot = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);

  const relocation = db.relocateRevokedFolder(folder.id, privateId, true);
  assert.equal(relocation.success, true);
  const forked = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.notEqual(forked.client_folder_id, snapshot.client_folder_id);
  assert.equal(forked.cloud_id, null);

  const ack = db.markFolderSyncedIfUnchanged(folder.id, snapshot, "old-cloud-folder");
  const afterAck = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.equal(ack.outcome, "identity-changed");
  assert.equal(ack.changes, 0);
  assert.deepEqual(afterAck, forked);

  const adoptAck = db.acknowledgeFolderCreate(
    folder.id,
    snapshot,
    snapshot.cloud_id,
    "canonical-old-client-folder",
    "old-cloud-folder",
    "2026-07-29T13:30:00.000Z"
  );
  assert.equal(adoptAck.outcome, "identity-changed");
  assert.equal(adoptAck.changes, 0);
  assert.deepEqual(
    db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id),
    forked,
    "a late pull-side identity adoption must not overwrite the fork either"
  );
});

test("acknowledgeFolderCreate settles an exact snapshot and adopts collision identity", (t) => {
  const db = createDb(t);
  if (!db) return;
  const folder = db.createFolder("Collision candidate").folder;
  const snapshot = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  const cloudUpdatedAt = "2026-07-29T14:00:00.000Z";

  const ack = db.acknowledgeFolderCreate(
    folder.id,
    snapshot,
    snapshot.cloud_id,
    "cloud-winner-client-folder",
    "cloud-winner-folder",
    cloudUpdatedAt
  );
  const linked = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.equal(ack.outcome, "synced");
  assert.equal(ack.changes, 1);
  assert.equal(linked.client_folder_id, "cloud-winner-client-folder");
  assert.equal(linked.cloud_id, "cloud-winner-folder");
  assert.equal(linked.sync_status, "synced");
  assert.equal(linked.updated_at, cloudUpdatedAt);
});

test("acknowledgeFolderCreate guards pull-side adoption with the pre-request cloud id", (t) => {
  const db = createDb(t);
  if (!db) return;
  const folder = db.createFolder("Already linked").folder;
  db.markFolderSynced(folder.id, "cloud-linked-folder");
  db.renameFolder(folder.id, "Already linked queued");
  const snapshot = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);

  const ack = db.acknowledgeFolderCreate(
    folder.id,
    snapshot,
    snapshot.cloud_id,
    "canonical-linked-client-folder",
    "cloud-linked-folder",
    "2026-07-29T14:30:00.000Z"
  );
  const adopted = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.equal(ack.outcome, "synced");
  assert.equal(ack.changes, 1);
  assert.equal(adopted.client_folder_id, "canonical-linked-client-folder");
  assert.equal(adopted.cloud_id, "cloud-linked-folder");
  assert.equal(adopted.sync_status, "synced");
});

test("acknowledgeFolderCreate adopts onto a newer same-identity edit without settling it", (t) => {
  const db = createDb(t);
  if (!db) return;
  const folder = db.createFolder("Roadmap").folder;
  const snapshot = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);

  db.db
    .prepare("UPDATE folders SET name = 'Roadmap v2', sync_status = 'pending' WHERE id = ?")
    .run(folder.id);
  const ack = db.acknowledgeFolderCreate(
    folder.id,
    snapshot,
    snapshot.cloud_id,
    folder.client_folder_id,
    "cloud-roadmap",
    "2026-07-29T15:00:00.000Z"
  );
  const linked = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.equal(linked.updated_at, snapshot.updated_at, "the edit shares the request timestamp");
  assert.equal(ack.outcome, "pending");
  assert.equal(ack.changes, 1);
  assert.equal(linked.name, "Roadmap v2");
  assert.equal(linked.cloud_id, "cloud-roadmap");
  assert.equal(linked.sync_status, "pending");
});

test("acknowledgeFolderCreate queues a team-to-Personal move for scope retraction", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Folder move race" }).space;
  const folder = db.createFolder("Moving folder", team.id).folder;
  const snapshot = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);

  const move = db.moveFolderToSpace(folder.id, db.getPrivateSpaceId());
  assert.equal(move.success, true);
  const ack = db.acknowledgeFolderCreate(
    folder.id,
    snapshot,
    snapshot.cloud_id,
    folder.client_folder_id,
    "team-folder-created-in-flight",
    "2026-07-29T15:30:00.000Z"
  );
  const moved = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.equal(ack.outcome, "pending");
  assert.equal(moved.cloud_id, "team-folder-created-in-flight");
  assert.equal(moved.left_team, 1);
  assert.ok(
    db.getPendingFolders("team").some((candidate) => candidate.id === folder.id),
    "the scope retraction must push even when personal backup is disabled"
  );
});

test("acknowledgeFolderCreate never reattaches a folder forked during the request", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Folder create race" }).space;
  const folder = db.createFolder("Fresh team folder", team.id).folder;
  const snapshot = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);

  const relocation = db.relocateRevokedFolder(folder.id, privateId, true);
  assert.equal(relocation.success, true);
  const forked = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.notEqual(forked.client_folder_id, snapshot.client_folder_id);

  const ack = db.acknowledgeFolderCreate(
    folder.id,
    snapshot,
    snapshot.cloud_id,
    snapshot.client_folder_id,
    "stale-team-cloud-folder",
    "2026-07-29T16:00:00.000Z"
  );
  const afterAck = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  assert.equal(ack.outcome, "identity-changed");
  assert.equal(ack.changes, 0);
  assert.deepEqual(afterAck, forked);
  assert.equal(afterAck.cloud_id, null);
  assert.equal(afterAck.sync_status, "pending");
});

test("relocateRevokedFolder preserves dirty children and hard-deletes server-owned ones", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Ops" }).space;
  const folder = db.createFolder("Q3 calls", team.id).folder;
  db.markFolderSynced(folder.id, "cloud-folder-1");

  const clean = db.saveNote("Recap", "server copy", "personal", null, null, folder.id).note;
  db.markNoteSynced(clean.id, "cloud-note-1");
  const dirty = db.saveNote("Edits", "unpushed work", "personal", null, null, folder.id).note;
  db.markNoteSynced(dirty.id, "cloud-note-2", "2026-07-28T07:00:00.000Z", "revoked-folder-owner");
  db.updateNote(dirty.id, { content: "unpushed work v2" });
  db.updateNoteShareState(dirty.id, { is_shared: 1, share_token: "revoked-folder-token" });
  const draft = db.saveNote("Draft", "never synced", "personal", null, null, folder.id).note;
  const cleanChat = db.createAgentConversation("Clean note chat", clean.id);
  db.markConversationSynced(cleanChat.id, "cloud-conversation-1");
  db.addAgentMessage(cleanChat.id, "user", "revoked team content");
  const dirtyChat = db.createAgentConversation("Dirty note chat", dirty.id, team.id, folder.id);
  db.addAgentMessage(dirtyChat.id, "user", "keep this local edit");
  db.db
    .prepare(
      "INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, 'spk_0', 'Alice')"
    )
    .run(clean.id);

  // Clean folder: the row is deleted, only dirty/never-synced children survive.
  const result = db.relocateRevokedFolder(folder.id, privateId, false);
  assert.ok(result.success);
  assert.equal(result.folder, null);
  assert.equal(result.folderName, "Q3 calls");
  assert.deepEqual(result.deletedNoteIds, [clean.id]);
  assert.deepEqual(
    result.relocatedNotes.map((n) => n.id).sort((a, b) => a - b),
    [dirty.id, draft.id]
  );
  assert.equal(db.getNote(clean.id), null);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) as count FROM speaker_mappings WHERE note_id = ?").get(clean.id)
      .count,
    0
  );
  assert.equal(db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id), undefined);
  for (const survivor of [db.getNote(dirty.id), db.getNote(draft.id)]) {
    assert.equal(survivor.space_id, privateId);
    assert.equal(survivor.folder_id, null);
    assert.equal(survivor.cloud_id, null);
    assert.equal(survivor.sync_status, "pending");
  }
  assert.notEqual(db.getNote(dirty.id).client_note_id, dirty.client_note_id, "identity forked");
  assert.equal(db.getNote(dirty.id).cloud_updated_at, null, "fork clears the old cloud base");
  assert.equal(db.getNote(dirty.id).owner_user_id, null, "fork clears the old owner");
  assert.equal(db.getNote(dirty.id).is_shared, 0, "forked note is private");
  assert.equal(db.getNote(dirty.id).share_token, null, "forked note drops its share token");
  const retiredChat = db.db
    .prepare("SELECT * FROM agent_conversations WHERE id = ?")
    .get(cleanChat.id);
  assert.ok(retiredChat.deleted_at, "the removed note's synced chat is retired");
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?")
      .get(cleanChat.id).count,
    0,
    "revoked team chat content is removed"
  );
  assert.deepEqual(db.getConversationsForNote(clean.id), []);
  const relocatedChat = db.getAgentConversation(dirtyChat.id);
  assert.equal(relocatedChat.note_id, dirty.id);
  assert.equal(relocatedChat.space_id, null);
  assert.equal(relocatedChat.folder_id, null);
  assert.equal(relocatedChat.messages.length, 1, "the dirty note's chat follows its Personal fork");

  // Dirty folder: preserved in Personal with a forked identity, children keep
  // their folder link, and a name collision falls back to a suffixed rename.
  db.createFolder("Projects");
  const team2 = createTestTeamSpace(db, { name: "Design" }).space;
  const dirtyFolder = db.createFolder("Projects", team2.id).folder;
  db.markFolderSynced(dirtyFolder.id, "cloud-folder-2");
  db.renameFolder(dirtyFolder.id, "Projects");
  const child = db.saveNote("Spec", "body", "personal", null, null, dirtyFolder.id).note;

  const preserved = db.relocateRevokedFolder(dirtyFolder.id, privateId, true);
  assert.ok(preserved.success);
  assert.equal(preserved.folder.name, "Projects (2)");
  assert.equal(preserved.folder.space_id, privateId);
  assert.equal(preserved.folder.cloud_id, null);
  assert.equal(preserved.folder.sync_status, "pending");
  assert.notEqual(preserved.folder.client_folder_id, dirtyFolder.client_folder_id);
  const movedChild = db.getNote(child.id);
  assert.equal(movedChild.space_id, privateId);
  assert.equal(movedChild.folder_id, dirtyFolder.id, "children keep the preserved folder link");
  assert.equal(movedChild.cloud_id, null);
});

test("getFolderNoteCounts attributes space-root notes per space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Ops" }).space;
  const folder = db.createFolder("Docs", team.id).folder;
  db.saveNote("Filed", "body", "personal", null, null, folder.id);
  db.saveNote("Root A", "body", "personal", null, null, null, team.id);
  db.saveNote("Root B", "body", "personal", null, null, null, team.id);
  const tombstoned = db.saveNote("Gone", "body", "personal", null, null, null, team.id).note;
  db.deleteNote(tombstoned.id);

  const counts = db.getFolderNoteCounts();
  const folderRow = counts.find((c) => c.folder_id === folder.id);
  assert.equal(folderRow.space_id, team.id);
  assert.equal(folderRow.count, 1);

  const teamRootRow = counts.find((c) => c.folder_id === null && c.space_id === team.id);
  assert.equal(teamRootRow.count, 2, "space-root notes count per space, excluding tombstones");
  assert.ok(
    !counts.some((c) => c.folder_id === null && c.space_id === privateId),
    "no root row for spaces without root notes"
  );
});

test("folders rebuild succeeds on a legacy DB with notes referencing folders", (t) => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spaces-db-"));
  let legacy;
  try {
    const BetterSqlite = require("better-sqlite3");
    legacy = new BetterSqlite(path.join(userDataDir, "transcriptions.db"));
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }

  // Pre-migration shape: folders still carries the table-level UNIQUE(name)
  // and notes rows reference them. better-sqlite3 enables foreign_keys by
  // default, so the rebuild's DROP TABLE used to throw on exactly this DB.
  legacy.exec(`
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'Untitled Note',
      content TEXT NOT NULL DEFAULT '',
      note_type TEXT NOT NULL DEFAULT 'personal',
      source_file TEXT,
      audio_duration_seconds REAL,
      folder_id INTEGER REFERENCES folders(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO folders (name, is_default, sort_order) VALUES ('Personal', 1, 0), ('Projects', 0, 1);
    INSERT INTO notes (title, content, folder_id) VALUES
      ('Legacy note one', 'body', 1),
      ('Legacy note two', 'body', 2),
      ('Legacy note three', 'body', 2);
  `);
  legacy.close();

  const db = new DatabaseManager();

  const foldersSql = db.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
    .get().sql;
  assert.ok(!foldersSql.includes("UNIQUE"), "rebuild dropped the UNIQUE(name) constraint");
  assert.equal(
    db.db.pragma("foreign_keys", { simple: true }),
    1,
    "foreign key enforcement is restored after the rebuild"
  );

  const privateId = db.getPrivateSpaceId();
  const notes = db.db.prepare("SELECT title, folder_id, space_id FROM notes ORDER BY id").all();
  assert.equal(notes.length, 3, "all legacy notes survive the rebuild");
  assert.deepEqual(
    notes.map((n) => n.folder_id),
    [1, 2, 2],
    "notes keep their folder references"
  );
  assert.ok(
    notes.every((n) => n.space_id === privateId),
    "legacy notes are backfilled into the private space"
  );
  const folders = db.db.prepare("SELECT id, name, space_id FROM folders ORDER BY id").all();
  // init may seed additional defaults (e.g. "Videos"); the legacy folders
  // must survive with their ids intact.
  assert.deepEqual(
    folders.filter((f) => ["Personal", "Projects"].includes(f.name)).map((f) => f.id),
    [1, 2],
    "both legacy folders survive with their ids"
  );
  assert.ok(
    folders.every((f) => f.space_id === privateId),
    "all folders are backfilled into the private space"
  );
  db.db.close();
});

test("purgeSpace preserves dirty cloud-backed notes with forked identities", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Revoked" }).space;
  const folder = db.createFolder("Ops", team.id).folder;

  const dirty = db.saveNote(
    "Edited offline",
    "walrus intel",
    "personal",
    null,
    null,
    folder.id
  ).note;
  db.markNoteSynced(dirty.id, "cloud-dirty-note", "2026-07-28T08:00:00.000Z", "old-team-owner");
  db.updateNote(dirty.id, { content: "walrus intel v2" });
  db.updateNoteShareState(dirty.id, { is_shared: 1, share_token: "purged-space-token" });
  const errored = db.saveNote(
    "Errored push",
    "narwhal notes",
    "personal",
    null,
    null,
    folder.id
  ).note;
  db.markNoteSynced(errored.id, "cloud-error-note", "2026-07-28T08:30:00.000Z", "old-team-owner");
  db.updateNote(errored.id, { content: "narwhal v2" });
  db.markNoteSyncError(errored.id);
  const clean = db.saveNote("Clean", "synced beluga", "personal", null, null, folder.id).note;
  db.markNoteSynced(clean.id, "cloud-clean-note");
  const before = { dirty: db.getNote(dirty.id), errored: db.getNote(errored.id) };

  const result = db.purgeSpace(team.id);
  assert.ok(result.success);
  assert.equal(result.relocatedCount, 2);

  // Unpushed edits ('pending' and 'error') survive in the private space as
  // forked personal notes; only the clean server-owned copy is destroyed.
  for (const [id, prior] of [
    [dirty.id, before.dirty],
    [errored.id, before.errored],
  ]) {
    const relocated = db.getNote(id);
    assert.equal(relocated.space_id, privateId);
    assert.equal(relocated.folder_id, null);
    assert.equal(relocated.cloud_id, null);
    assert.equal(relocated.cloud_updated_at, null);
    assert.equal(relocated.owner_user_id, null);
    assert.equal(relocated.sync_status, "pending");
    assert.equal(relocated.left_team, 0);
    assert.notEqual(relocated.client_note_id, prior.client_note_id);
    assert.equal(relocated.is_shared, 0);
    assert.equal(relocated.share_token, null);
  }
  const count = (sql, ...args) => db.db.prepare(sql).get(...args).count;
  assert.equal(count("SELECT COUNT(*) as count FROM notes WHERE id = ?", clean.id), 0);
});

test("purgeSpace survives tombstones in other spaces referencing its folders", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = createTestTeamSpace(db, { name: "Movers" }).space;

  // Deleting a note keeps folder_id on the tombstone; moving the folder into
  // the team afterwards leaves a cross-space reference that must not abort
  // the purge on the notes→folders FK.
  const folder = db.createFolder("Shared docs", privateId).folder;
  const note = db.saveNote("Doomed", "tombstone gazelle", "personal", null, null, folder.id).note;
  db.markNoteSynced(note.id, "cloud-tombstone-note");
  db.deleteNote(note.id);
  db.moveFolderToSpace(folder.id, team.id);

  const result = db.purgeSpace(team.id);
  assert.ok(result.success);

  const tombstone = db.db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id);
  assert.ok(tombstone.deleted_at, "the tombstone survives — its cloud delete still has to push");
  assert.equal(tombstone.folder_id, null);
  assert.ok(db.getPendingNoteDeletes().some((n) => n.id === note.id));
  const count = (sql, ...args) => db.db.prepare(sql).get(...args).count;
  assert.equal(count("SELECT COUNT(*) as count FROM folders WHERE space_id = ?", team.id), 0);
  assert.equal(count("SELECT COUNT(*) as count FROM spaces WHERE id = ?", team.id), 0);
});

test("getPendingNotes includes error rows so failed pushes retry", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Retry me", "flaky ferret").note;
  db.markNoteSyncError(note.id);

  assert.ok(db.getPendingNotes().some((n) => n.id === note.id));
  assert.ok(db.getPendingNotes("private").some((n) => n.id === note.id));
});

test("upsertSpaceFromCloud inserts as pending and never flips status on update", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = db.upsertSpaceFromCloud({ id: "team-1", name: "Cloud team", workspace_id: "ws-1" });
  assert.equal(team.sync_status, "pending", "new spaces need a content backfill");

  // A second mirror pass before the backfill completes must not settle it.
  const again = db.upsertSpaceFromCloud({ id: "team-1", name: "Renamed" });
  assert.equal(again.sync_status, "pending");

  db.setSpaceSyncStatus(team.id, "synced");
  const after = db.upsertSpaceFromCloud({ id: "team-1", name: "Renamed again" });
  assert.equal(after.sync_status, "synced");
});

test("upsertSpaceFromCloud round-trips the teams mirror as a parsed array", (t) => {
  const db = createDb(t);
  if (!db) return;
  const teams = [{ id: "team-1", name: "Design", my_role: "admin" }];
  const space = db.upsertSpaceFromCloud({
    id: "space-1",
    name: "Design space",
    workspace_id: "ws-1",
    teams,
  });
  assert.deepEqual(space.teams, teams);
  assert.deepEqual(db.getSpaces().find((s) => s.id === space.id).teams, teams);
  assert.deepEqual(db.getSpaceByCloudSpaceId("space-1").teams, teams);

  // A corrupt column must degrade to an empty array, never throw.
  db.db.prepare("UPDATE spaces SET teams = 'not json' WHERE id = ?").run(space.id);
  assert.deepEqual(db.getSpaces().find((s) => s.id === space.id).teams, []);
});

test("upsertSpaceFromCloud adopts a pre-spaces row via its single backfilled team", (t) => {
  const db = createDb(t);
  if (!db) return;
  // A row mirrored before the spaces refactor: keyed by cloud_team_id only.
  db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, cloud_team_id, kind, name, sort_order, sync_status) VALUES ('legacy-client-id', 'team-1', 'team', 'Legacy', 1, 'synced')"
    )
    .run();
  const legacyId = db.db.prepare("SELECT id FROM spaces WHERE cloud_team_id = 'team-1'").get().id;

  const adopted = db.upsertSpaceFromCloud({
    id: "team-1",
    name: "Legacy",
    workspace_id: "ws-1",
    teams: [{ id: "team-1", name: "Legacy team", my_role: "member" }],
  });
  assert.equal(adopted.id, legacyId, "local id survives so chats and tree state keep working");
  assert.equal(adopted.cloud_space_id, "team-1");
  assert.equal(adopted.sync_status, "synced", "adoption must not trigger a backfill storm");

  // Idempotent: the next pass hits the cloud_space_id key, no duplicate row.
  const again = db.upsertSpaceFromCloud({
    id: "team-1",
    name: "Legacy",
    teams: [{ id: "team-1", name: "Legacy team", my_role: "member" }],
  });
  assert.equal(again.id, legacyId);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) as count FROM spaces WHERE kind = 'team'").get().count,
    1
  );
});

test("upsertSpaceFromCloud never adopts by team for multi-team spaces", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, cloud_team_id, kind, name, sort_order, sync_status) VALUES ('legacy-client-id', 'team-1', 'team', 'Legacy', 1, 'synced')"
    )
    .run();

  const fresh = db.upsertSpaceFromCloud({
    id: "space-9",
    name: "Multi",
    teams: [
      { id: "team-1", name: "A", my_role: "member" },
      { id: "team-2", name: "B", my_role: null },
    ],
  });
  assert.notEqual(fresh.client_space_id, "legacy-client-id");
  assert.equal(fresh.sync_status, "pending", "a genuinely new space still backfills");
});
