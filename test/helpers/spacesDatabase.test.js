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
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
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
  assert.ok(indexes.includes("idx_folders_space_name"));

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
  const team = db.createSpace({ name: "Design" });
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
  const team = db.createSpace({ name: "Eng" }).space;
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
  const team = db.createSpace({ name: "Secret" }).space;
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

  assert.equal(count("SELECT COUNT(*) as count FROM notes WHERE space_id = ?", privateId), 1);
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

test("saveNote resolves default folders within the target space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = db.createSpace({ name: "Ops" }).space;
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
  const team = db.createSpace({ name: "Growth" }).space;
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
  const team = db.createSpace({ name: "Ops" }).space;
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
  const team = db.createSpace({ name: "Sales" }).space;
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

test("setSpaceSyncStatus flips a space's sync_status", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = db.createSpace({ name: "Docs" }).space;

  assert.ok(db.setSpaceSyncStatus(team.id, "synced").success);
  assert.equal(db.getSpaces().find((s) => s.id === team.id).sync_status, "synced");

  assert.ok(db.setSpaceSyncStatus(team.id, "pending").success);
  assert.equal(db.getSpaces().find((s) => s.id === team.id).sync_status, "pending");

  assert.equal(db.setSpaceSyncStatus(99999, "synced").success, false);
});
