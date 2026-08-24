const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: {} };
  return originalLoad.call(this, request, parent, isMain);
};
const DatabaseManager = require("../../src/helpers/database.js");
Module._load = originalLoad;

function createDatabaseManager() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE spaces (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT NOT NULL DEFAULT 'synced',
      deleted_at TEXT
    );
    CREATE TABLE space_accounts (
      space_id INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      PRIMARY KEY (space_id, account_id)
    );
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      client_folder_id TEXT,
      space_id INTEGER,
      account_id TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      note_type TEXT NOT NULL DEFAULT 'personal',
      source_file TEXT,
      audio_duration_seconds REAL,
      folder_id INTEGER,
      space_id INTEGER,
      client_note_id TEXT,
      account_id TEXT,
      deleted_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE agent_conversations (
      id INTEGER PRIMARY KEY,
      note_id INTEGER,
      folder_id INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE agent_messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE speaker_mappings (note_id INTEGER NOT NULL);
    CREATE TABLE note_speaker_embeddings (note_id INTEGER NOT NULL);
    CREATE TABLE optimistic_folder_delete_rows (
      folder_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER
    );
    INSERT INTO spaces (id, kind) VALUES (1, 'private'), (2, 'team'), (3, 'team');
    INSERT INTO space_accounts (space_id, account_id) VALUES
      (2, 'account-a'),
      (3, 'account-b');
  `);

  const manager = Object.create(DatabaseManager.prototype);
  manager.db = sqlite;
  manager.activeAccountId = null;
  return { manager, sqlite };
}

test("account scope shows legacy and active personal rows plus every workspace row", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());

  sqlite.exec(`
    INSERT INTO folders (id, name, space_id, account_id) VALUES
      (1, 'Legacy', 1, NULL),
      (2, 'Personal A', 1, 'account-a'),
      (3, 'Personal B', 1, 'account-b'),
      (4, 'Workspace A', 2, NULL),
      (5, 'Workspace B', 3, NULL);
    INSERT INTO notes (id, title, content, folder_id, space_id, account_id) VALUES
      (1, 'Legacy', '', 1, 1, NULL),
      (2, 'Personal A', '', 2, 1, 'account-a'),
      (3, 'Personal B', '', 3, 1, 'account-b'),
      (4, 'Workspace A', '', 4, 2, NULL),
      (5, 'Workspace B', '', 5, 3, NULL);
  `);

  manager.setActiveAccountId("account-a");

  assert.deepEqual(
    manager
      .getNotes(null, 100)
      .map((note) => note.title)
      .sort(),
    ["Legacy", "Personal A", "Workspace A"]
  );
  assert.deepEqual(
    manager
      .getFolders()
      .map((folder) => folder.name)
      .sort(),
    ["Legacy", "Personal A", "Workspace A"]
  );

  manager.setActiveAccountId("account-b");
  assert.deepEqual(
    manager
      .getNotes(null, 100)
      .map((note) => note.title)
      .sort(),
    ["Legacy", "Personal B", "Workspace B"]
  );
  assert.deepEqual(
    manager
      .getSpaces()
      .filter((space) => space.kind === "team")
      .map((space) => space.id),
    [3]
  );
});

test("new personal content is attributed to the active account but workspace content is not", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  manager.setActiveAccountId("account-a");

  const personalFolder = manager.createFolder("Personal A", 1).folder;
  const workspaceFolder = manager.createFolder("Workspace", 2).folder;
  const personalNote = manager.saveNote("Personal A", "", "personal", null, null, null, 1).note;
  const workspaceNote = manager.saveNote("Workspace", "", "personal", null, null, null, 2).note;

  assert.equal(personalFolder.account_id, "account-a");
  assert.equal(personalNote.account_id, "account-a");
  assert.equal(workspaceFolder.account_id, null);
  assert.equal(workspaceNote.account_id, null);
});

test("deleting one account removes only its personal rows and dependent private content", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  sqlite.exec(`
    INSERT INTO folders (id, name, space_id, account_id) VALUES
      (1, 'Legacy', 1, NULL),
      (2, 'Personal A', 1, 'account-a'),
      (3, 'Personal B', 1, 'account-b'),
      (4, 'Workspace A', 2, 'account-a');
    INSERT INTO notes (id, title, content, folder_id, space_id, account_id) VALUES
      (1, 'Legacy', '', 1, 1, NULL),
      (2, 'Personal A', '', 2, 1, 'account-a'),
      (3, 'Personal B', '', 3, 1, 'account-b'),
      (4, 'Workspace A', '', 4, 2, 'account-a');
    INSERT INTO agent_conversations (id, note_id, folder_id) VALUES (1, 2, 2);
    INSERT INTO agent_messages (id, conversation_id) VALUES (1, 1);
    INSERT INTO speaker_mappings (note_id) VALUES (2);
    INSERT INTO note_speaker_embeddings (note_id) VALUES (2);
    INSERT INTO optimistic_folder_delete_rows (folder_id, entity_type, entity_id)
    VALUES (2, 'note', 2);
  `);
  manager.setActiveAccountId("account-a");

  const result = manager.deleteAccountData("account-a");

  assert.deepEqual(result.deletedNoteIds, [2]);
  assert.deepEqual(result.deletedFolderIds, [2]);
  assert.deepEqual(
    sqlite
      .prepare("SELECT title FROM notes ORDER BY id")
      .all()
      .map((row) => row.title),
    ["Legacy", "Personal B", "Workspace A"]
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT name FROM folders ORDER BY id")
      .all()
      .map((row) => row.name),
    ["Legacy", "Personal B", "Workspace A"]
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM agent_conversations").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM agent_messages").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM speaker_mappings").get().count, 0);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM note_speaker_embeddings").get().count,
    0
  );
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS count FROM space_accounts WHERE account_id = 'account-b'")
      .get().count,
    1
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM optimistic_folder_delete_rows").get().count,
    0
  );
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS count FROM space_accounts WHERE account_id = 'account-a'")
      .get().count,
    0
  );
});

test("account deletion refuses to target an account outside the active scope", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  manager.setActiveAccountId("account-a");

  assert.throws(() => manager.deleteAccountData("account-b"), /active account scope/);
});

test("revoking one local account preserves a workspace used by another account", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  sqlite.exec(`
    INSERT INTO space_accounts (space_id, account_id) VALUES (2, 'account-b');
    INSERT INTO folders (id, name, space_id, account_id) VALUES
      (1, 'Shared workspace folder', 2, NULL);
    INSERT INTO notes (id, title, content, folder_id, space_id, account_id) VALUES
      (1, 'Shared workspace note', '', 1, 2, NULL);
  `);
  manager.setActiveAccountId("account-a");

  assert.equal(manager._releaseActiveSpaceMembershipIfShared(2), true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM spaces WHERE id = 2").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM folders WHERE id = 1").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM notes WHERE id = 1").get().count, 1);
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM space_accounts WHERE space_id = 2 AND account_id = 'account-a'"
      )
      .get().count,
    0
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM space_accounts WHERE space_id = 2 AND account_id = 'account-b'"
      )
      .get().count,
    1
  );
});

test("stale space mutations cannot target another account's workspace", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  manager.setActiveAccountId("account-a");

  assert.deepEqual(manager.updateSpace(3, { name: "Wrong account" }), {
    success: false,
    error: "Space not found",
  });
  assert.deepEqual(manager.setSpaceSyncStatus(3, "pending"), {
    success: false,
    space: null,
  });
  assert.deepEqual(manager.purgeSpace(3, { mode: "destructive" }), {
    success: false,
    error: "Space not found",
  });
  assert.equal(sqlite.prepare("SELECT name FROM spaces WHERE id = 3").get().name, null);
  assert.equal(
    sqlite.prepare("SELECT sync_status FROM spaces WHERE id = 3").get().sync_status,
    "synced"
  );
});
