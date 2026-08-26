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
      cloud_id TEXT,
      sync_status TEXT NOT NULL DEFAULT 'synced',
      space_id INTEGER,
      account_id TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
      cloud_id TEXT,
      sync_status TEXT NOT NULL DEFAULT 'synced',
      account_id TEXT,
      transcript TEXT,
      participants TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_notes_client_note_id ON notes(client_note_id);
    CREATE TABLE agent_conversations (
      id INTEGER PRIMARY KEY,
      note_id INTEGER,
      folder_id INTEGER,
      cloud_id TEXT,
      sync_status TEXT NOT NULL DEFAULT 'synced',
      deleted_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
      entity_id INTEGER,
      original_sync_status TEXT,
      original_deleted_at TEXT,
      original_updated_at TEXT,
      PRIMARY KEY (folder_id, entity_type, entity_id)
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

// node:sqlite has no better-sqlite3-style transaction(); the folder deletion
// paths require one.
function installTransactionShim(sqlite) {
  sqlite.transaction =
    (fn) =>
    (...args) => {
      sqlite.exec("BEGIN");
      try {
        const result = fn(...args);
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    };
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

test("deleting a folder releases other accounts' notes to the space root instead of deleting them", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  installTransactionShim(sqlite);
  sqlite.exec(`
    INSERT INTO folders (id, name, space_id, account_id) VALUES (10, 'Projects', 1, NULL);
    INSERT INTO notes (id, title, content, folder_id, space_id, account_id) VALUES
      (1, 'A note', '', 10, 1, 'account-a'),
      (2, 'Legacy note', '', 10, 1, NULL),
      (3, 'B note', '', 10, 1, 'account-b');
    INSERT INTO agent_conversations (id, note_id) VALUES (1, 1), (2, 3);
    INSERT INTO agent_messages (id, conversation_id) VALUES (1, 1), (2, 2);
    INSERT INTO speaker_mappings (note_id) VALUES (1), (3);
    INSERT INTO note_speaker_embeddings (note_id) VALUES (1), (3);
  `);
  manager.setActiveAccountId("account-a");

  const result = manager.deleteFolder(10);

  assert.equal(result.success, true);
  assert.deepEqual(result.noteIds.sort(), [1, 2]);
  assert.deepEqual(
    result.relocatedNotes.map((note) => note.id),
    [3]
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT id, folder_id, space_id, deleted_at, sync_status FROM notes")
      .all()
      .map((row) => ({ ...row })),
    [{ id: 3, folder_id: null, space_id: 1, deleted_at: null, sync_status: "pending" }]
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM folders").get().count, 0);
  assert.deepEqual(
    sqlite
      .prepare("SELECT id, note_id FROM agent_conversations")
      .all()
      .map((row) => ({ ...row })),
    [{ id: 2, note_id: 3 }]
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT id FROM agent_messages")
      .all()
      .map((row) => ({ ...row })),
    [{ id: 2 }]
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT note_id FROM speaker_mappings")
      .all()
      .map((row) => ({ ...row })),
    [{ note_id: 3 }]
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT note_id FROM note_speaker_embeddings")
      .all()
      .map((row) => ({ ...row })),
    [{ note_id: 3 }]
  );
});

test("an optimistic cloud folder delete never journals or hides other accounts' notes", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  installTransactionShim(sqlite);
  sqlite.exec(`
    INSERT INTO folders (id, name, space_id, account_id, cloud_id) VALUES
      (10, 'Projects', 1, NULL, 'cf-1');
    INSERT INTO notes (id, title, content, folder_id, space_id, account_id, cloud_id) VALUES
      (1, 'A note', '', 10, 1, 'account-a', 'cn-a'),
      (3, 'B note', '', 10, 1, 'account-b', 'cn-b');
  `);
  manager.setActiveAccountId("account-a");

  const result = manager.deleteFolder(10);

  assert.equal(result.success, true);
  assert.deepEqual(result.noteIds, [1]);
  assert.deepEqual(
    result.relocatedNotes.map((note) => note.id),
    [3]
  );
  const own = sqlite.prepare("SELECT deleted_at, sync_status FROM notes WHERE id = 1").get();
  assert.ok(own.deleted_at != null);
  assert.equal(own.sync_status, "folder_delete_pending");
  assert.deepEqual(
    {
      ...sqlite.prepare("SELECT folder_id, deleted_at, sync_status FROM notes WHERE id = 3").get(),
    },
    { folder_id: null, deleted_at: null, sync_status: "pending" }
  );
  assert.deepEqual(
    sqlite
      .prepare(
        "SELECT entity_id FROM optimistic_folder_delete_rows WHERE entity_type = 'note' ORDER BY entity_id"
      )
      .all()
      .map((row) => ({ ...row })),
    [{ entity_id: 1 }]
  );
});

test("hard folder deletion preserves other accounts' notes, tombstones included", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  installTransactionShim(sqlite);
  sqlite.exec(`
    INSERT INTO folders (id, name, space_id, account_id, cloud_id) VALUES
      (10, 'Projects', 1, NULL, 'cf-1');
    INSERT INTO notes (id, title, content, folder_id, space_id, account_id, cloud_id, sync_status, deleted_at) VALUES
      (1, 'A note', '', 10, 1, 'account-a', 'cn-a', 'synced', NULL),
      (3, 'B note', '', 10, 1, 'account-b', 'cn-b', 'synced', NULL),
      (4, 'B tombstone', '', 10, 1, 'account-b', 'cn-b2', 'pending', '2026-08-01 00:00:00');
  `);
  manager.setActiveAccountId("account-a");

  const result = manager.hardDeleteFolder(10);

  assert.equal(result.success, true);
  assert.deepEqual(result.noteIds, [1]);
  assert.deepEqual(result.relocatedNotes.map((note) => note.id).sort(), [3, 4]);
  assert.deepEqual(
    sqlite
      .prepare("SELECT id, folder_id, deleted_at FROM notes ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 3, folder_id: null, deleted_at: null },
      { id: 4, folder_id: null, deleted_at: "2026-08-01 00:00:00" },
    ]
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM folders").get().count, 0);
});

function importRow(clientNoteId, title) {
  return {
    clientNoteId,
    title,
    content: "",
    sourceFile: null,
    transcript: null,
    participants: null,
    createdAt: null,
  };
}

test("imported notes carry the active account and never land in another account's folder", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  installTransactionShim(sqlite);
  sqlite.exec(
    "INSERT INTO folders (id, name, space_id, account_id) VALUES (20, 'Imported', 1, 'account-b')"
  );
  manager.setActiveAccountId("account-a");

  const result = manager.importNotes([importRow("import-1", "Imported note")]);

  assert.equal(result.success, true);
  assert.equal(result.imported, 1);
  const note = sqlite
    .prepare("SELECT account_id, folder_id, space_id FROM notes WHERE client_note_id = 'import-1'")
    .get();
  assert.equal(note.account_id, "account-a");
  assert.equal(note.space_id, 1);
  assert.notEqual(note.folder_id, 20);
  const folder = sqlite
    .prepare("SELECT name, account_id FROM folders WHERE id = ?")
    .get(note.folder_id);
  assert.deepEqual({ ...folder }, { name: "Imported", account_id: "account-a" });

  const again = manager.importNotes([importRow("import-2", "Second import")]);
  assert.equal(again.folderId, note.folder_id);
});

test("a guest import stays device-owned and cannot reuse an account's folder", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());
  installTransactionShim(sqlite);
  sqlite.exec(
    "INSERT INTO folders (id, name, space_id, account_id) VALUES (20, 'Imported', 1, 'account-b')"
  );
  manager.setActiveAccountId(null);

  const result = manager.importNotes([importRow("import-guest", "Guest import")]);

  assert.equal(result.imported, 1);
  const note = sqlite
    .prepare("SELECT account_id, folder_id FROM notes WHERE client_note_id = 'import-guest'")
    .get();
  assert.equal(note.account_id, null);
  assert.notEqual(note.folder_id, 20);
  const folder = sqlite
    .prepare("SELECT name, account_id FROM folders WHERE id = ?")
    .get(note.folder_id);
  assert.deepEqual({ ...folder }, { name: "Imported", account_id: null });
});
