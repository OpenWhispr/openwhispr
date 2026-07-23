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

test("space-root notes keep folder_id NULL across relaunches", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = db.createSpace({ name: "Team" }).space;
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
  const team = db.createSpace({ name: "Shared" }).space;
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
  const team = db.createSpace({ name: "Docs" }).space;

  assert.ok(db.setSpaceSyncStatus(team.id, "synced").success);
  assert.equal(db.getSpaces().find((s) => s.id === team.id).sync_status, "synced");

  assert.ok(db.setSpaceSyncStatus(team.id, "pending").success);
  assert.equal(db.getSpaces().find((s) => s.id === team.id).sync_status, "pending");

  assert.equal(db.setSpaceSyncStatus(99999, "synced").success, false);
});

test("team→private moves set left_team so retractions stay in the team queue", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = db.createSpace({ name: "Sales" }).space;

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
  const team = db.createSpace({ name: "Growth" }).space;
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

test("markNoteSyncedIfUnchanged settles only rows untouched since the push snapshot", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Doc", "v1").note;
  const snapshot = db.getNote(note.id);

  const settled = db.markNoteSyncedIfUnchanged(note.id, "cloud-1", snapshot.updated_at);
  assert.equal(settled.changes, 1);
  assert.equal(db.getNote(note.id).sync_status, "synced");
  assert.equal(db.getNote(note.id).cloud_id, "cloud-1");

  // Simulate an edit landing while the PATCH was in flight.
  db.db
    .prepare(
      "UPDATE notes SET content = 'v2', sync_status = 'pending', updated_at = datetime('now', '+1 hour') WHERE id = ?"
    )
    .run(note.id);
  const stale = db.markNoteSyncedIfUnchanged(note.id, "cloud-1", snapshot.updated_at);
  assert.equal(stale.changes, 0);
  assert.equal(db.getNote(note.id).sync_status, "pending", "the mid-flight edit must still push");
});

test("markFolderSyncedIfUnchanged settles only rows untouched since the push snapshot", (t) => {
  const db = createDb(t);
  if (!db) return;
  const folder = db.createFolder("Design").folder;
  const readFolder = () => db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
  const snapshot = readFolder();

  const settled = db.markFolderSyncedIfUnchanged(folder.id, "cloud-folder-1", snapshot.updated_at);
  assert.equal(settled.changes, 1);
  assert.equal(readFolder().sync_status, "synced");
  assert.equal(readFolder().cloud_id, "cloud-folder-1");

  // Simulate a rename landing while the PATCH was in flight.
  db.db
    .prepare(
      "UPDATE folders SET name = 'Design v2', sync_status = 'pending', updated_at = datetime('now', '+1 hour') WHERE id = ?"
    )
    .run(folder.id);
  const stale = db.markFolderSyncedIfUnchanged(folder.id, "cloud-folder-1", snapshot.updated_at);
  assert.equal(stale.changes, 0);
  assert.equal(readFolder().sync_status, "pending", "the mid-flight rename must still push");
});

test("relocateRevokedFolder preserves dirty children and hard-deletes server-owned ones", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = db.createSpace({ name: "Ops" }).space;
  const folder = db.createFolder("Q3 calls", team.id).folder;
  db.markFolderSynced(folder.id, "cloud-folder-1");

  const clean = db.saveNote("Recap", "server copy", "personal", null, null, folder.id).note;
  db.markNoteSynced(clean.id, "cloud-note-1");
  const dirty = db.saveNote("Edits", "unpushed work", "personal", null, null, folder.id).note;
  db.markNoteSynced(dirty.id, "cloud-note-2");
  db.updateNote(dirty.id, { content: "unpushed work v2" });
  const draft = db.saveNote("Draft", "never synced", "personal", null, null, folder.id).note;
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

  // Dirty folder: preserved in Personal with a forked identity, children keep
  // their folder link, and a name collision falls back to a suffixed rename.
  db.createFolder("Projects");
  const team2 = db.createSpace({ name: "Design" }).space;
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
  const team = db.createSpace({ name: "Ops" }).space;
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
  const team = db.createSpace({ name: "Revoked" }).space;
  const folder = db.createFolder("Ops", team.id).folder;

  const dirty = db.saveNote(
    "Edited offline",
    "walrus intel",
    "personal",
    null,
    null,
    folder.id
  ).note;
  db.markNoteSynced(dirty.id, "cloud-dirty-note");
  db.updateNote(dirty.id, { content: "walrus intel v2" });
  const errored = db.saveNote(
    "Errored push",
    "narwhal notes",
    "personal",
    null,
    null,
    folder.id
  ).note;
  db.markNoteSynced(errored.id, "cloud-error-note");
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
    assert.equal(relocated.sync_status, "pending");
    assert.equal(relocated.left_team, 0);
    assert.notEqual(relocated.client_note_id, prior.client_note_id);
  }
  const count = (sql, ...args) => db.db.prepare(sql).get(...args).count;
  assert.equal(count("SELECT COUNT(*) as count FROM notes WHERE id = ?", clean.id), 0);
});

test("purgeSpace survives tombstones in other spaces referencing its folders", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const team = db.createSpace({ name: "Movers" }).space;

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

test("createSpace refuses non-team kinds so the private space stays unique", (t) => {
  const db = createDb(t);
  if (!db) return;
  const result = db.createSpace({ name: "Sneaky", kind: "private" });
  assert.equal(result.success, false);

  const privateCount = db.db
    .prepare("SELECT COUNT(*) as count FROM spaces WHERE kind = 'private'")
    .get().count;
  assert.equal(privateCount, 1);
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
  assert.equal(db.db.prepare("SELECT COUNT(*) as count FROM spaces WHERE kind = 'team'").get().count, 1);
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
