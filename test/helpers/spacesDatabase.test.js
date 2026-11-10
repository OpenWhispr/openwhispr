const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
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
const debugLogger = require("../../src/helpers/debugLogger");

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

function folderIndexNames(sqlite) {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'folders'")
    .all()
    .map((row) => row.name);
}

test("relaunch succeeds when two accounts have same-named folders in one space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db._standInPrivateSpaceId();
  const insertFolder = db.db.prepare(
    "INSERT INTO folders (name, space_id, account_id, client_folder_id) VALUES (?, ?, ?, ?)"
  );
  for (const accountId of ["account-a", "account-b"]) {
    for (const name of ["Personal", "Meetings", "Videos"]) {
      insertFolder.run(name, privateId, accountId, `${accountId}-${name}`);
    }
  }
  db.db.close();

  const db2 = new DatabaseManager();
  t.after(() => db2.db.close());
  assert.ok(!folderIndexNames(db2.db).includes("idx_folders_space_name"));
  const personalCount = db2.db
    .prepare("SELECT COUNT(*) AS count FROM folders WHERE space_id = ? AND name = 'Personal'")
    .get(privateId).count;
  assert.equal(personalCount, 3, "legacy row plus one per account");
});

test("an old database with globally unique folder names migrates to per-account indexes", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db.close();
  const dbPath = path.join(userDataDir, "transcriptions.db");
  fs.rmSync(dbPath, { force: true });

  const BetterSqlite = require("better-sqlite3");
  const legacy = new BetterSqlite(dbPath);
  legacy.exec(`
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO folders (name, is_default, sort_order) VALUES ('Personal', 1, 0), ('Work', 0, 1);
  `);
  legacy.close();

  const migrated = new DatabaseManager();
  t.after(() => migrated.db.close());
  const foldersSql = migrated.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
    .get().sql;
  assert.ok(!foldersSql.includes("UNIQUE"));
  const indexes = folderIndexNames(migrated.db);
  assert.ok(!indexes.includes("idx_folders_space_name"));
  assert.ok(indexes.includes("idx_folders_space_legacy_name"));
  assert.ok(indexes.includes("idx_folders_space_account_name"));

  const privateId = migrated.getPrivateSpaceId();
  const work = migrated.db.prepare("SELECT * FROM folders WHERE name = 'Work'").get();
  assert.equal(work.space_id, privateId);
  assert.equal(work.account_id, null);
  assert.throws(
    () =>
      migrated.db.prepare("INSERT INTO folders (name, space_id) VALUES ('Work', ?)").run(privateId),
    /UNIQUE constraint failed/,
    "legacy folder names stay unique per space"
  );
});

// Private spaces per account (user_version 6). The v5 shape is one private row
// that every account's notes share; these helpers build it on a fresh database.
const SEEDED_AT = "2026-01-02 03:04:05";

function seedFolder(
  sqlite,
  spaceId,
  { name, accountId = null, isDefault = 0, sortOrder = 0, cloudId = null, deletedAt = null }
) {
  return Number(
    sqlite
      .prepare(
        `INSERT INTO folders (name, is_default, sort_order, client_folder_id, cloud_id, sync_status, deleted_at, space_id, account_id)
         VALUES (?, ?, ?, ?, ?, 'synced', ?, ?, ?)`
      )
      .run(name, isDefault, sortOrder, randomUUID(), cloudId, deletedAt, spaceId, accountId)
      .lastInsertRowid
  );
}

function seedNote(
  sqlite,
  spaceId,
  { title, accountId = null, folderId = null, cloudId = null, deletedAt = null }
) {
  return Number(
    sqlite
      .prepare(
        `INSERT INTO notes (title, content, client_note_id, cloud_id, sync_status, deleted_at, folder_id, space_id, account_id, updated_at)
         VALUES (?, '', ?, ?, 'synced', ?, ?, ?, ?, ?)`
      )
      .run(title, randomUUID(), cloudId, deletedAt, folderId, spaceId, accountId, SEEDED_AT)
      .lastInsertRowid
  );
}

function seedChat(
  sqlite,
  { title, accountId, spaceId = null, folderId = null, legacyUnattributed = 0 }
) {
  return Number(
    sqlite
      .prepare(
        "INSERT INTO agent_conversations (title, space_id, folder_id, client_conversation_id, account_id, legacy_unattributed) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(title, spaceId, folderId, randomUUID(), accountId, legacyUnattributed).lastInsertRowid
  );
}

function seededFolderId(sqlite, name) {
  return sqlite
    .prepare("SELECT id FROM folders WHERE name = ? AND is_default = 1 AND account_id IS NULL")
    .get(name).id;
}

// Closes the database as a v5 build left it and opens it again with this build.
function relaunchFromVersion5(t, db) {
  const sqlite = db.db;
  sqlite.exec("DROP INDEX IF EXISTS idx_spaces_private_identity");
  sqlite.exec("DROP INDEX IF EXISTS idx_spaces_private_default");
  for (const column of ["account_id", "is_default"]) {
    if (sqlite.pragma("table_info('spaces')").some((existing) => existing.name === column)) {
      sqlite.exec(`ALTER TABLE spaces DROP COLUMN ${column}`);
    }
  }
  sqlite.pragma("user_version = 5");
  sqlite.close();
  return relaunch(t);
}

function relaunch(t) {
  const next = new DatabaseManager();
  t.after(() => {
    if (next.db.open) next.db.close();
  });
  return next;
}

function privateRows(sqlite) {
  return sqlite
    .prepare("SELECT id, account_id, workspace_id FROM spaces WHERE kind = 'private' ORDER BY id")
    .all();
}

function pendingRowId(sqlite, accountId) {
  return sqlite
    .prepare(
      "SELECT id FROM spaces WHERE kind = 'private' AND account_id = ? AND workspace_id IS NULL"
    )
    .get(accountId)?.id;
}

function noteRow(sqlite, id) {
  return sqlite
    .prepare(
      "SELECT id, space_id, folder_id, account_id, sync_status, updated_at, cloud_id, left_team, deleted_at FROM notes WHERE id = ?"
    )
    .get(id);
}

function folderRow(sqlite, id) {
  return sqlite.prepare("SELECT * FROM folders WHERE id = ?").get(id);
}

function assertEveryRowInItsFolderSpace(sqlite) {
  assert.deepEqual(
    sqlite
      .prepare(
        "SELECT n.id FROM notes n JOIN folders f ON f.id = n.folder_id WHERE n.space_id IS NOT f.space_id"
      )
      .all(),
    [],
    "every note's folder is in the note's own space"
  );
  assert.deepEqual(
    sqlite
      .prepare(
        "SELECT c.id FROM agent_conversations c JOIN folders f ON f.id = c.folder_id WHERE c.space_id IS NOT f.space_id"
      )
      .all(),
    [],
    "every folder chat is in its folder's space"
  );
}

test("migration 6 gives each account its own pending private space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const sqlite = db.db;
  const aWork = seedFolder(sqlite, standInId, { name: "Work", accountId: "a" });
  const bWork = seedFolder(sqlite, standInId, { name: "Work", accountId: "b" });
  const legacyFolder = seedFolder(sqlite, standInId, { name: "Legacy" });
  const aNotes = [
    seedNote(sqlite, standInId, { title: "a root", accountId: "a" }),
    seedNote(sqlite, standInId, { title: "a work", accountId: "a", folderId: aWork }),
  ];
  const bNotes = [
    seedNote(sqlite, standInId, { title: "b root", accountId: "b" }),
    seedNote(sqlite, standInId, { title: "b work", accountId: "b", folderId: bWork }),
  ];
  const nullNotes = [
    seedNote(sqlite, standInId, { title: "signed out" }),
    seedNote(sqlite, standInId, { title: "legacy", folderId: legacyFolder }),
  ];
  const before = new Map(
    [...aNotes, ...bNotes, ...nullNotes].map((id) => [id, noteRow(sqlite, id)])
  );

  const migrated = relaunchFromVersion5(t, db);
  const after = migrated.db;
  assert.equal(after.pragma("user_version", { simple: true }), 6);

  const rows = privateRows(after);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { id: standInId, account_id: null, workspace_id: null });
  const aRow = pendingRowId(after, "a");
  const bRow = pendingRowId(after, "b");
  assert.ok(aRow && bRow && aRow !== bRow && aRow !== standInId && bRow !== standInId);

  for (const id of aNotes) {
    assert.deepEqual(noteRow(after, id), { ...before.get(id), space_id: aRow });
  }
  for (const id of bNotes) {
    assert.deepEqual(noteRow(after, id), { ...before.get(id), space_id: bRow });
  }
  for (const id of nullNotes) {
    assert.deepEqual(noteRow(after, id), before.get(id));
  }
  assert.equal(folderRow(after, aWork).space_id, aRow);
  assert.equal(folderRow(after, aWork).account_id, "a");
  assert.equal(folderRow(after, bWork).space_id, bRow);
  assert.equal(folderRow(after, legacyFolder).space_id, standInId);
  assert.deepEqual(
    after
      .prepare(
        "SELECT DISTINCT account_id FROM notes WHERE space_id = ? UNION SELECT DISTINCT account_id FROM folders WHERE space_id = ?"
      )
      .all(standInId, standInId),
    [{ account_id: null }],
    "the stand-in keeps only rows with no account"
  );
  assertEveryRowInItsFolderSpace(after);
});

test("migration 6 is idempotent across launches", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const meetings = seededFolderId(db.db, "Meetings");
  seedNote(db.db, standInId, { title: "a", accountId: "a", folderId: meetings });
  seedNote(db.db, standInId, { title: "b", accountId: "b", folderId: meetings });
  seedNote(db.db, standInId, { title: "signed out", folderId: meetings });

  const first = relaunchFromVersion5(t, db);
  const spaces = privateRows(first.db);
  const notes = first.db.prepare("SELECT * FROM notes ORDER BY id").all();
  const folders = first.db.prepare("SELECT * FROM folders ORDER BY id").all();
  assert.equal(spaces.length, 3);
  first.db.close();

  const second = relaunch(t);
  assert.deepEqual(privateRows(second.db), spaces);
  assert.deepEqual(second.db.prepare("SELECT * FROM notes ORDER BY id").all(), notes);
  assert.deepEqual(second.db.prepare("SELECT * FROM folders ORDER BY id").all(), folders);
});

test("the identity index refuses a second private row for the same account and workspace", (t) => {
  const db = createDb(t);
  if (!db) return;
  const insert = db.db.prepare(
    "INSERT INTO spaces (client_space_id, kind, name, account_id, workspace_id, deleted_at) VALUES (?, 'private', 'Personal', ?, ?, ?)"
  );
  const unique = /UNIQUE constraint failed/;

  assert.throws(() => insert.run(randomUUID(), null, null, null), unique, "a second stand-in");
  insert.run(randomUUID(), "a", null, null);
  assert.throws(() => insert.run(randomUUID(), "a", null, null), unique, "a second pending row");
  insert.run(randomUUID(), "a", "w1", null);
  assert.throws(() => insert.run(randomUUID(), "a", "w1", null), unique);
  insert.run(randomUUID(), "a", "w2", null);
  insert.run(randomUUID(), "b", "w1", null);
  insert.run(randomUUID(), "a", "w1", "2026-01-01T00:00:00Z");
  db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, account_id, workspace_id) VALUES (?, 'team', 'Team', 'a', 'w1')"
    )
    .run(randomUUID());
});

test("migration 6 keeps a single-account device's folder ids and cloud ids", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const sqlite = db.db;
  const personal = seededFolderId(sqlite, "Personal");
  const meetings = seededFolderId(sqlite, "Meetings");
  const videos = seededFolderId(sqlite, "Videos");
  sqlite
    .prepare(
      "UPDATE folders SET cloud_id = 'cloud-' || id, sync_status = 'synced' WHERE id IN (?, ?)"
    )
    .run(personal, meetings);
  const notes = [
    seedNote(sqlite, standInId, { title: "one", accountId: "a", folderId: personal }),
    seedNote(sqlite, standInId, { title: "two", accountId: "a", folderId: personal }),
    seedNote(sqlite, standInId, {
      title: "meeting",
      accountId: "a",
      folderId: meetings,
      cloudId: "cloud-note",
    }),
  ];
  const foldersBefore = new Map([personal, meetings].map((id) => [id, folderRow(sqlite, id)]));
  const notesBefore = new Map(notes.map((id) => [id, noteRow(sqlite, id)]));

  const migrated = relaunchFromVersion5(t, db);
  const after = migrated.db;
  const aRow = pendingRowId(after, "a");
  assert.equal(privateRows(after).length, 2);

  for (const id of [personal, meetings]) {
    assert.deepEqual(folderRow(after, id), {
      ...foldersBefore.get(id),
      space_id: aRow,
      account_id: "a",
    });
  }
  for (const id of notes) {
    assert.deepEqual(noteRow(after, id), { ...notesBefore.get(id), space_id: aRow });
  }
  const emptyVideos = folderRow(after, videos);
  assert.equal(emptyVideos.space_id, standInId, "an empty seeded folder stays in the stand-in");
  assert.equal(emptyVideos.account_id, null);
  assert.equal(
    after.prepare("SELECT COUNT(*) AS count FROM folders WHERE space_id = ?").get(aRow).count,
    2,
    "no folder is copied"
  );
  assertEveryRowInItsFolderSpace(after);
});

test("migration 6 gives each account its own copy of a folder they share", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const sqlite = db.db;
  const meetings = seededFolderId(sqlite, "Meetings");
  sqlite.prepare("UPDATE folders SET cloud_id = 'cloud-meetings' WHERE id = ?").run(meetings);
  const meetingsBefore = folderRow(sqlite, meetings);
  const aNote = seedNote(sqlite, standInId, { title: "a", accountId: "a", folderId: meetings });
  const bNote = seedNote(sqlite, standInId, { title: "b", accountId: "b", folderId: meetings });
  const nullNote = seedNote(sqlite, standInId, { title: "signed out", folderId: meetings });
  const notesBefore = new Map([aNote, bNote, nullNote].map((id) => [id, noteRow(sqlite, id)]));

  const migrated = relaunchFromVersion5(t, db);
  const after = migrated.db;
  assert.deepEqual(folderRow(after, meetings), meetingsBefore, "the shared folder stays put");
  assert.deepEqual(after.prepare("SELECT id FROM notes WHERE folder_id = ?").all(meetings), [
    { id: nullNote },
  ]);
  assert.deepEqual(noteRow(after, nullNote), notesBefore.get(nullNote));

  for (const [accountId, noteId] of [
    ["a", aNote],
    ["b", bNote],
  ]) {
    const home = pendingRowId(after, accountId);
    const copy = after
      .prepare("SELECT * FROM folders WHERE space_id = ? AND name = 'Meetings'")
      .get(home);
    assert.ok(copy, `${accountId} gets its own Meetings`);
    assert.equal(copy.account_id, accountId);
    assert.equal(copy.is_default, meetingsBefore.is_default);
    assert.equal(copy.sort_order, meetingsBefore.sort_order);
    assert.equal(copy.cloud_id, null);
    assert.equal(copy.sync_status, "synced");
    assert.equal(copy.deleted_at, null);
    assert.notEqual(copy.client_folder_id, meetingsBefore.client_folder_id);
    assert.deepEqual(noteRow(after, noteId), {
      ...notesBefore.get(noteId),
      space_id: home,
      folder_id: copy.id,
    });
  }
  assertEveryRowInItsFolderSpace(after);
});

test("migration 6 moves soft-deleted rows and private root chats with their account", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const sqlite = db.db;
  const personal = seededFolderId(sqlite, "Personal");
  seedNote(sqlite, standInId, { title: "signed out", folderId: personal });
  const deletedAt = "2026-01-03T00:00:00Z";
  const goneFolder = seedFolder(sqlite, standInId, {
    name: "Gone",
    accountId: "a",
    cloudId: "cloud-gone",
    deletedAt,
  });
  const goneChild = seedNote(sqlite, standInId, {
    title: "gone child",
    accountId: "a",
    folderId: goneFolder,
    cloudId: "cloud-gone-child",
    deletedAt,
  });
  const tombstone = seedNote(sqlite, standInId, {
    title: "tombstone",
    accountId: "a",
    folderId: personal,
    cloudId: "cloud-tombstone",
    deletedAt,
  });
  const aRootChat = seedChat(sqlite, { title: "a root", accountId: "a", spaceId: standInId });
  const aFolderChat = seedChat(sqlite, {
    title: "a in Personal",
    accountId: "a",
    spaceId: standInId,
    folderId: personal,
  });
  const nullRootChat = seedChat(sqlite, {
    title: "signed out",
    accountId: null,
    spaceId: standInId,
  });
  const noteChat = seedChat(sqlite, { title: "on a note", accountId: "a" });
  const notesBefore = new Map([goneChild, tombstone].map((id) => [id, noteRow(sqlite, id)]));

  const migrated = relaunchFromVersion5(t, db);
  const after = migrated.db;
  const aRow = pendingRowId(after, "a");
  const aPersonal = after
    .prepare("SELECT id FROM folders WHERE space_id = ? AND account_id = 'a' AND name = 'Personal'")
    .get(aRow).id;

  assert.equal(folderRow(after, goneFolder).space_id, aRow);
  assert.equal(folderRow(after, goneFolder).deleted_at, deletedAt);
  assert.equal(folderRow(after, goneFolder).cloud_id, "cloud-gone");
  assert.deepEqual(noteRow(after, goneChild), { ...notesBefore.get(goneChild), space_id: aRow });
  assert.deepEqual(noteRow(after, tombstone), {
    ...notesBefore.get(tombstone),
    space_id: aRow,
    folder_id: aPersonal,
  });

  const chat = (id) =>
    after.prepare("SELECT space_id, folder_id FROM agent_conversations WHERE id = ?").get(id);
  assert.deepEqual(chat(aRootChat), { space_id: aRow, folder_id: null });
  assert.deepEqual(chat(aFolderChat), { space_id: aRow, folder_id: aPersonal });
  assert.deepEqual(chat(nullRootChat), { space_id: standInId, folder_id: null });
  assert.deepEqual(chat(noteChat), { space_id: null, folder_id: null });
  assertEveryRowInItsFolderSpace(after);
});

test("migration 6 moves a folder whole when its only other rows are chats from before attribution", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const sqlite = db.db;
  const meetings = seededFolderId(sqlite, "Meetings");
  sqlite.prepare("UPDATE folders SET cloud_id = 'cloud-meetings' WHERE id = ?").run(meetings);
  const meetingsBefore = folderRow(sqlite, meetings);
  const aNote = seedNote(sqlite, standInId, { title: "a", accountId: "a", folderId: meetings });
  // Every container chat from before #2924 reads as unattributed until the
  // account's sign-in claims it, which comes after this launch's migration.
  const legacyChat = seedChat(sqlite, {
    title: "before attribution",
    accountId: null,
    spaceId: standInId,
    folderId: meetings,
    legacyUnattributed: 1,
  });

  const migrated = relaunchFromVersion5(t, db);
  const after = migrated.db;
  const aRow = pendingRowId(after, "a");
  assert.deepEqual(folderRow(after, meetings), {
    ...meetingsBefore,
    space_id: aRow,
    account_id: "a",
  });
  assert.equal(noteRow(after, aNote).folder_id, meetings);
  assert.equal(noteRow(after, aNote).space_id, aRow);
  assert.deepEqual(
    after
      .prepare(
        "SELECT space_id, folder_id, account_id, legacy_unattributed FROM agent_conversations WHERE id = ?"
      )
      .get(legacyChat),
    { space_id: aRow, folder_id: meetings, account_id: null, legacy_unattributed: 1 },
    "the chat follows its folder and waits for the sign-in claim"
  );
  assertEveryRowInItsFolderSpace(after);
});

test("migration 6 still splits a folder holding a chat written signed out", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const sqlite = db.db;
  const meetings = seededFolderId(sqlite, "Meetings");
  const aNote = seedNote(sqlite, standInId, { title: "a", accountId: "a", folderId: meetings });
  const signedOutChat = seedChat(sqlite, {
    title: "signed out",
    accountId: null,
    spaceId: standInId,
    folderId: meetings,
  });

  const migrated = relaunchFromVersion5(t, db);
  const after = migrated.db;
  const aRow = pendingRowId(after, "a");
  assert.equal(folderRow(after, meetings).space_id, standInId);
  const aMeetings = after
    .prepare("SELECT id FROM folders WHERE space_id = ? AND account_id = 'a' AND name = 'Meetings'")
    .get(aRow).id;
  assert.notEqual(aMeetings, meetings);
  assert.equal(noteRow(after, aNote).folder_id, aMeetings);
  assert.deepEqual(
    after
      .prepare("SELECT space_id, folder_id FROM agent_conversations WHERE id = ?")
      .get(signedOutChat),
    { space_id: standInId, folder_id: meetings }
  );
  assertEveryRowInItsFolderSpace(after);
});

test("migration 6 leaves other owners' rows beside the folders it moves", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const sqlite = db.db;
  // a's own folder holding a note written signed out.
  const aWork = seedFolder(sqlite, standInId, { name: "Work", accountId: "a" });
  const strayNote = seedNote(sqlite, standInId, { title: "signed out", folderId: aWork });
  // The seeded Personal used only by a, while a already has its own Personal.
  const personal = seededFolderId(sqlite, "Personal");
  const aPersonal = seedFolder(sqlite, standInId, { name: "Personal", accountId: "a" });
  const aInSeeded = seedNote(sqlite, standInId, { title: "a", accountId: "a", folderId: personal });
  // A folder deleted on the server's say-so, still holding a's and a signed-out note.
  const deletedAt = "2026-01-03T00:00:00Z";
  const gone = seedFolder(sqlite, standInId, { name: "Gone", cloudId: "cloud-gone", deletedAt });
  const aGone = seedNote(sqlite, standInId, {
    title: "a gone",
    accountId: "a",
    folderId: gone,
    deletedAt,
  });
  seedNote(sqlite, standInId, { title: "signed out gone", folderId: gone, deletedAt });

  const migrated = relaunchFromVersion5(t, db);
  const after = migrated.db;
  const aRow = pendingRowId(after, "a");

  assert.equal(folderRow(after, aWork).space_id, aRow);
  const nullWork = after
    .prepare("SELECT * FROM folders WHERE space_id = ? AND account_id IS NULL AND name = 'Work'")
    .get(standInId);
  assert.ok(nullWork, "the signed-out note gets a Work of its own in the stand-in");
  assert.equal(noteRow(after, strayNote).folder_id, nullWork.id);
  assert.equal(noteRow(after, strayNote).space_id, standInId);

  assert.equal(folderRow(after, aPersonal).space_id, aRow);
  assert.equal(folderRow(after, personal).space_id, standInId);
  assert.equal(noteRow(after, aInSeeded).folder_id, aPersonal);
  assert.equal(noteRow(after, aInSeeded).space_id, aRow);

  assert.equal(folderRow(after, gone).space_id, standInId);
  assert.equal(noteRow(after, aGone).folder_id, gone);
  assert.equal(noteRow(after, aGone).space_id, standInId);
  assertEveryRowInItsFolderSpace(after);
});

test("migration 6 cut short completes on the next launch", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const sqlite = db.db;
  const meetings = seededFolderId(sqlite, "Meetings");
  const aNote = seedNote(sqlite, standInId, { title: "a", accountId: "a", folderId: meetings });
  const bNote = seedNote(sqlite, standInId, { title: "b", accountId: "b", folderId: meetings });
  seedNote(sqlite, standInId, { title: "signed out", folderId: meetings });
  // Stops the run after account a's rows have moved, partway through b's.
  sqlite.exec(`
    CREATE TRIGGER cut_migration_short BEFORE UPDATE OF space_id ON notes
    WHEN NEW.account_id = 'b' BEGIN SELECT RAISE(ABORT, 'cut short'); END
  `);
  const notesBefore = sqlite.prepare("SELECT * FROM notes ORDER BY id").all();
  const foldersBefore = sqlite.prepare("SELECT * FROM folders ORDER BY id").all();
  const logged = t.mock.method(debugLogger, "error", () => {});

  const interrupted = relaunchFromVersion5(t, db);
  assert.deepEqual(
    logged.mock.calls.map((call) => call.arguments.slice(0, 2)),
    [["Splitting the private space by account failed", { error: "cut short" }]],
    "the launch opens the database and logs the failure"
  );
  logged.mock.restore();
  assert.equal(interrupted.db.pragma("user_version", { simple: true }), 5);
  assert.equal(privateRows(interrupted.db).length, 1, "nothing of the cut-short run is kept");
  assert.deepEqual(interrupted.db.prepare("SELECT * FROM notes ORDER BY id").all(), notesBefore);
  assert.deepEqual(
    interrupted.db.prepare("SELECT * FROM folders ORDER BY id").all(),
    foldersBefore
  );
  interrupted.db.exec("DROP TRIGGER cut_migration_short");
  interrupted.db.close();

  const completed = relaunch(t);
  assert.equal(completed.db.pragma("user_version", { simple: true }), 6);
  assert.equal(privateRows(completed.db).length, 3);
  assert.equal(noteRow(completed.db, aNote).space_id, pendingRowId(completed.db, "a"));
  assert.equal(noteRow(completed.db, bNote).space_id, pendingRowId(completed.db, "b"));
  assertEveryRowInItsFolderSpace(completed.db);
});

test("migration 6 reuses an account's pending row a stopped run already made", (t) => {
  const db = createDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const sqlite = db.db;
  try {
    sqlite.exec("ALTER TABLE spaces ADD COLUMN account_id TEXT");
  } catch (err) {
    if (!err.message.includes("duplicate column")) throw err;
  }
  const aRow = Number(
    sqlite
      .prepare(
        "INSERT INTO spaces (client_space_id, kind, name, sort_order, sync_status, account_id) VALUES (?, 'private', 'Personal', 0, 'synced', 'a')"
      )
      .run(randomUUID()).lastInsertRowid
  );
  const aWork = seedFolder(sqlite, aRow, { name: "Work", accountId: "a" });
  const aMoved = seedNote(sqlite, aRow, { title: "a moved", accountId: "a", folderId: aWork });
  const aLeft = seedNote(sqlite, standInId, { title: "a left", accountId: "a" });
  const bNote = seedNote(sqlite, standInId, { title: "b", accountId: "b" });
  sqlite.pragma("user_version = 5");
  sqlite.close();

  const completed = relaunch(t);
  const after = completed.db;
  assert.equal(after.pragma("user_version", { simple: true }), 6);
  assert.equal(privateRows(after).length, 3);
  assert.equal(pendingRowId(after, "a"), aRow);
  assert.equal(noteRow(after, aMoved).space_id, aRow);
  assert.equal(noteRow(after, aMoved).folder_id, aWork);
  assert.equal(noteRow(after, aLeft).space_id, aRow);
  assert.equal(noteRow(after, bNote).space_id, pendingRowId(after, "b"));
});

test("pre-migration rows are backfilled into the private space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db._standInPrivateSpaceId();
  assert.ok(privateId);
  // Rows with no account are seen in the stand-in only while signed out.
  db.setActiveAccountId(null);
  assert.ok(db.getFolders().length > 0);

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
    { settleIfUnchanged: false }
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
  db.markNoteSynced(tombstoned.id, "cloud-note-gone");
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

test("upsertSpaceFromCloud mirrors the direct role and clears it when the grant goes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const created = db.upsertSpaceFromCloud({
    id: "space-1",
    name: "Design space",
    workspace_id: "ws-1",
    my_role: "admin",
    my_direct_role: "admin",
    teams: [],
  });
  assert.equal(created.my_direct_role, "admin");
  assert.equal(db.getSpaceByCloudSpaceId("space-1").my_direct_role, "admin");

  // Access now flows only through a team: the effective role survives, the
  // direct grant must not linger and keep "Leave space" offered.
  const updated = db.upsertSpaceFromCloud({
    id: "space-1",
    name: "Design space",
    workspace_id: "ws-1",
    my_role: "member",
    teams: [{ id: "team-1", name: "Design", my_role: "member" }],
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.my_role, "member");
  assert.equal(updated.my_direct_role, null);
});

test("upsertSpaceFromCloud stores and returns capabilities", (t) => {
  const db = createDb(t);
  if (!db) return;
  const capabilities = {
    edit_notes: true,
    manage_members: false,
    manage_settings: false,
    leave: true,
  };
  const created = db.upsertSpaceFromCloud({
    id: "space-1",
    name: "Design space",
    workspace_id: "ws-1",
    teams: [],
    capabilities,
  });
  assert.deepEqual(created.capabilities, capabilities);
  assert.deepEqual(db.getSpaceByCloudSpaceId("space-1").capabilities, capabilities);

  // A later pass replaces the stored object.
  const promoted = { edit_notes: true, manage_members: true, manage_settings: true, leave: true };
  const updated = db.upsertSpaceFromCloud({
    id: "space-1",
    name: "Design space",
    workspace_id: "ws-1",
    teams: [],
    capabilities: promoted,
  });
  assert.equal(updated.id, created.id);
  assert.deepEqual(updated.capabilities, promoted);
});

test("space rows without capabilities read as null", (t) => {
  const db = createDb(t);
  if (!db) return;
  // An older API sends no capabilities at all.
  const created = db.upsertSpaceFromCloud({
    id: "space-1",
    name: "Design space",
    workspace_id: "ws-1",
    teams: [],
  });
  assert.equal(created.capabilities, null);

  const capabilities = {
    edit_notes: true,
    manage_members: false,
    manage_settings: false,
    leave: false,
  };
  db.upsertSpaceFromCloud({ id: "space-1", name: "Design space", teams: [], capabilities });
  // Dropping the field on the next pass must not leave stale capabilities behind.
  assert.equal(
    db.upsertSpaceFromCloud({ id: "space-1", name: "Design space", teams: [] }).capabilities,
    null
  );

  // A corrupt column degrades to null, never throws.
  db.db.prepare("UPDATE spaces SET capabilities = 'not json' WHERE id = ?").run(created.id);
  assert.equal(db.getSpaces().find((s) => s.id === created.id).capabilities, null);
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

test("a deferred create receipt retains team retraction while personal backup is off", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Deferred move" }).space;
  const note = db.saveNote("Draft", "team work", "personal", null, null, null, team.id).note;
  db.updateNote(note.id, { space_id: db.getPrivateSpaceId(), folder_id: null });
  const ack = db.acknowledgeNoteCreate(note.id, note, "team-cloud", null, null, {
    requiresReconciliation: true,
  });
  assert.equal(ack.outcome, "awaiting-cloud");
  assert.equal(db.getNote(note.id).left_team, 1);
  assert.ok(db.getPendingNotes("team").some((candidate) => candidate.id === note.id));
});

const noteRows = (db, id) =>
  db.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE id = ?").get(id).n;

test("a draft a space purge moves to Personal after a create attempt is removed on delete", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Ops" }).space;
  const draft = db.saveNote("Draft", "never uploaded", "personal", null, null, null, team.id).note;
  db.markNoteCreatesAttempted([draft.client_note_id]);

  assert.equal(db.purgeSpace(team.id).success, true);
  assert.notEqual(db.getNote(draft.id).client_note_id, draft.client_note_id);

  assert.deepEqual(db.deleteNote(draft.id), { success: true, id: draft.id });
  assert.equal(noteRows(db, draft.id), 0);
});

test("a draft moved out of a revoked folder after a create attempt is removed on delete", (t) => {
  const db = createDb(t);
  if (!db) return;
  const team = createTestTeamSpace(db, { name: "Ops" }).space;
  const folder = db.createFolder("Calls", team.id).folder;
  db.markFolderSynced(folder.id, "cloud-folder-revoked");
  const draft = db.saveNote("Draft", "never uploaded", "personal", null, null, folder.id).note;
  db.markNoteCreatesAttempted([draft.client_note_id]);

  assert.ok(db.relocateRevokedFolder(folder.id, db.getPrivateSpaceId(), true).success);
  assert.notEqual(db.getNote(draft.id).client_note_id, draft.client_note_id);

  assert.deepEqual(db.deleteNote(draft.id), { success: true, id: draft.id });
  assert.equal(noteRows(db, draft.id), 0);
});

test("a note given a new identity after a create attempt is removed on delete", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Forked", "body").note;
  db.markNoteCreatesAttempted([note.client_note_id]);
  db.updateNote(note.id, { client_note_id: randomUUID(), cloud_id: null });

  assert.deepEqual(db.deleteNote(note.id), { success: true, id: note.id });
  assert.equal(noteRows(db, note.id), 0);
});

test("a note that loses its cloud link but keeps its identity stays a tombstone on delete", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Refused", "body").note;
  db.markNoteCreatesAttempted([note.client_note_id]);
  db.updateNote(note.id, { cloud_id: null, cloud_updated_at: null });

  assert.deepEqual(db.deleteNote(note.id), { success: true, id: note.id });
  assert.ok(db.getNote(note.id).deleted_at);
});

// Private spaces per workspace and account (Task 2).

// A device nobody has signed in to yet: no account rows, signed out.
function createFreshDeviceDb(t) {
  const db = createDb(t);
  if (!db) return null;
  db.setActiveAccountId(null);
  db.db.prepare("DELETE FROM device_accounts").run();
  t.after(() => {
    if (db.db.open) db.db.close();
  });
  return db;
}

function spaceIdentity(sqlite, id) {
  return {
    ...sqlite
      .prepare("SELECT kind, account_id, workspace_id, deleted_at FROM spaces WHERE id = ?")
      .get(id),
  };
}

function privateSpaceIds(db) {
  return db
    .getSpaces()
    .filter((space) => space.kind === "private")
    .map((space) => space.id);
}

function chatRow(sqlite, id) {
  return {
    ...sqlite
      .prepare("SELECT space_id, folder_id, account_id FROM agent_conversations WHERE id = ?")
      .get(id),
  };
}

function signIn(db, accountId, scope = null) {
  db.setActiveAccountId(accountId);
  if (scope) db.setActiveWorkspaceScope(scope);
}

const W2_ACTIVE = { activeWorkspaceId: "w2", defaultWorkspaceId: "w1" };
const W1_ACTIVE = { activeWorkspaceId: "w1", defaultWorkspaceId: "w1" };

test("getPrivateSpaceId resolves the active workspace's private space for the active account", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  signIn(db, "a", W2_ACTIVE);

  const w2 = db.getPrivateSpaceId();
  assert.deepEqual(spaceIdentity(db.db, w2), {
    kind: "private",
    account_id: "a",
    workspace_id: "w2",
    deleted_at: null,
  });
  assert.equal(db.getPrivateSpaceId(), w2, "made once");
  assert.equal(db.getPrivateSpaceId("w2"), w2);

  db.setActiveWorkspaceScope(W1_ACTIVE);
  const pending = db.getPrivateSpaceId();
  assert.equal(
    pending,
    pendingRowId(db.db, "a"),
    "the default workspace starts as the pending row"
  );
  assert.equal(db.getDefaultPrivateSpaceId(), pending);
  assert.equal(db.getPrivateSpaceId("w2"), w2, "a named workspace wins over the active one");
  db.setActiveWorkspaceScope({ activeWorkspaceId: null, defaultWorkspaceId: null });
  assert.equal(db.getPrivateSpaceId(), pending, "an unknown workspace resolves to the default row");

  db.setActiveWorkspaceScope(W1_ACTIVE);
  db.bindDefaultPrivateSpace("w1");
  assert.equal(db.getPrivateSpaceId(), pending, "the same row, now bound");
  assert.equal(db.getDefaultPrivateSpaceId(), pending);
  assert.deepEqual(spaceIdentity(db.db, pending), {
    kind: "private",
    account_id: "a",
    workspace_id: "w1",
    deleted_at: null,
  });
  assert.equal(pendingRowId(db.db, "a"), undefined);

  // Another account starts from its own default, never the last account's workspaces.
  signIn(db, "b");
  const bDefault = db.getPrivateSpaceId();
  assert.deepEqual(spaceIdentity(db.db, bDefault), {
    kind: "private",
    account_id: "b",
    workspace_id: null,
    deleted_at: null,
  });
});

test("signed out resolves the stand-in", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  db.setActiveWorkspaceScope(W2_ACTIVE);

  assert.equal(db.getPrivateSpaceId(), standInId);
  assert.equal(db.getPrivateSpaceId("w2"), standInId);
  assert.equal(db.getDefaultPrivateSpaceId(), standInId);
  db.bindDefaultPrivateSpace("w1");
  assert.deepEqual(privateRows(db.db), [{ id: standInId, account_id: null, workspace_id: null }]);
  assert.equal(db.saveNote("Signed out", "").note.space_id, standInId);
});

test("getSpaces lists only the active account's private spaces", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  signIn(db, "a", W2_ACTIVE);
  const aW2 = db.getPrivateSpaceId();
  const aDefault = db.getDefaultPrivateSpaceId();
  signIn(db, "b");
  const bDefault = db.getPrivateSpaceId();

  signIn(db, "a", W2_ACTIVE);
  assert.deepEqual(privateSpaceIds(db), [aW2, aDefault], "the active workspace's Private first");
  db.setActiveWorkspaceScope(W1_ACTIVE);
  assert.deepEqual(privateSpaceIds(db), [aDefault, aW2]);
  assert.equal(db.getSpace(bDefault), null);
  assert.equal(db.getSpace(standInId), null);

  signIn(db, "b");
  assert.deepEqual(privateSpaceIds(db), [bDefault]);
  assert.equal(db.getSpace(aW2), null);
  assert.equal(db.getSpace(aDefault), null);

  signIn(db, null);
  assert.deepEqual(privateSpaceIds(db), [standInId]);
  assert.equal(db.getSpace(standInId).id, standInId);
  assert.equal(db.getSpace(aDefault), null);
  assert.equal(db.getSpace(bDefault), null);
});

test("NULL-account private notes are visible only while signed out", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  const signedOut = db.saveNote("Signed out", "").note;
  assert.equal(signedOut.space_id, standInId);
  assert.equal(signedOut.account_id, null);
  assert.ok(db.getNote(signedOut.id));
  assert.ok(db.getFolders().some((folder) => folder.space_id === standInId));

  signIn(db, "a", W1_ACTIVE);
  assert.equal(db.getNote(signedOut.id), null);
  assert.deepEqual(
    db.getNotes(null, 100).map((note) => note.id),
    []
  );
  assert.equal(
    db.getFolders().some((folder) => folder.space_id === standInId),
    false,
    "the stand-in's folders are hidden too"
  );
  assert.equal(db.getMeetingsFolder(standInId), null);
  assert.throws(() =>
    db.saveNote("Into the stand-in", "", "personal", null, null, null, standInId)
  );
  const own = db.saveNote("A's note", "").note;
  assert.equal(own.account_id, "a");

  signIn(db, null);
  assert.ok(db.getNote(signedOut.id));
  assert.equal(db.getNote(own.id), null, "signed out never sees an account's notes");
});

test("bindDefaultPrivateSpace merges into an existing row for that workspace", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  signIn(db, "a", { activeWorkspaceId: null, defaultWorkspaceId: null });
  const pending = db.getPrivateSpaceId();
  const pendingMeeting = db.saveNote("Before the list loaded", "", "meeting").note;
  const pendingIdea = db.saveNote("An idea", "").note;
  // A default folder some cloud holds can't just disappear: it stays, renamed.
  db.db
    .prepare("UPDATE folders SET cloud_id = 'cloud-personal' WHERE id = ?")
    .run(pendingIdea.folder_id);
  const pendingProjects = db.createFolder("Projects").folder;
  const meetingsChat = seedChat(db.db, {
    title: "Meetings chat",
    accountId: "a",
    spaceId: pending,
    folderId: pendingMeeting.folder_id,
  });
  const pendingChat = seedChat(db.db, { title: "Root chat", accountId: "a", spaceId: pending });
  const folderChat = seedChat(db.db, {
    title: "Projects chat",
    accountId: "a",
    spaceId: pending,
    folderId: pendingProjects.id,
  });

  // The active workspace was known before the default was.
  db.setActiveWorkspaceScope({ activeWorkspaceId: "w1", defaultWorkspaceId: null });
  const w1 = db.getPrivateSpaceId();
  assert.notEqual(w1, pending);
  const w1Meeting = db.saveNote("After", "", "meeting").note;
  const w1Projects = db.createFolder("Projects").folder;
  const before = noteRow(db.db, pendingMeeting.id);

  db.bindDefaultPrivateSpace("w1");

  assert.ok(spaceIdentity(db.db, pending).deleted_at, "the pending row is retired");
  assert.equal(db.getDefaultPrivateSpaceId(), w1);
  // Default folders fold into the target's own: one Meetings, one Personal.
  assert.deepEqual(noteRow(db.db, pendingMeeting.id), {
    ...before,
    space_id: w1,
    folder_id: w1Meeting.folder_id,
  });
  assert.equal(folderRow(db.db, pendingMeeting.folder_id), undefined, "the emptied default goes");
  assert.deepEqual(chatRow(db.db, meetingsChat), {
    space_id: w1,
    folder_id: w1Meeting.folder_id,
    account_id: "a",
  });
  const kept = folderRow(db.db, w1Meeting.folder_id);
  assert.deepEqual(
    { name: kept.name, is_default: kept.is_default, space_id: kept.space_id },
    { name: "Meetings", is_default: 1, space_id: w1 }
  );
  assert.equal(db.getMeetingsFolder().id, w1Meeting.folder_id);
  const w1Personal = db.db
    .prepare("SELECT id FROM folders WHERE space_id = ? AND name = 'Personal' AND is_default = 1")
    .get(w1).id;
  assert.equal(noteRow(db.db, pendingIdea.id).folder_id, w1Personal);
  const cloudPersonal = folderRow(db.db, pendingIdea.folder_id);
  assert.deepEqual(
    {
      name: cloudPersonal.name,
      is_default: cloudPersonal.is_default,
      space_id: cloudPersonal.space_id,
      cloud_id: cloudPersonal.cloud_id,
    },
    { name: "Personal (2)", is_default: 0, space_id: w1, cloud_id: "cloud-personal" }
  );
  // Other folders keep the " (2)" rename.
  assert.equal(folderRow(db.db, pendingProjects.id).name, "Projects (2)");
  assert.equal(folderRow(db.db, pendingProjects.id).space_id, w1);
  assert.equal(folderRow(db.db, w1Projects.id).name, "Projects");
  assert.deepEqual(chatRow(db.db, pendingChat), { space_id: w1, folder_id: null, account_id: "a" });
  assert.equal(chatRow(db.db, folderChat).space_id, w1);
  assert.deepEqual(privateSpaceIds(db), [w1]);
  assertEveryRowInItsFolderSpace(db.db);
});

test("claimSignedOutPrivateNotes moves signed-out notes to the signed-in account's default", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  const sqlite = db.db;
  const standInId = db._standInPrivateSpaceId();
  // The account already has an Ideas folder from an earlier session.
  signIn(db, "a", W1_ACTIVE);
  const home = db.getDefaultPrivateSpaceId();
  const aIdeas = db.createFolder("Ideas").folder;
  signIn(db, null);

  const seeded = ["Personal", "Meetings", "Videos"].map((name) => seededFolderId(sqlite, name));
  const meeting = db.saveNote("Signed-out meeting", "", "meeting").note;
  const root = seedNote(sqlite, standInId, { title: "At the root", cloudId: "cloud-root" });
  const ideas = db.createFolder("Ideas").folder;
  const idea = db.saveNote("Idea", "", "personal", null, null, ideas.id).note;
  const empty = db.createFolder("Empty").folder;
  const rootChat = db.createAgentConversation("Root chat", null, standInId);
  const meetingsChat = db.createAgentConversation("Meetings chat", null, standInId, seeded[1]);
  const ideasChat = db.createAgentConversation("Ideas chat", null, standInId, ideas.id);
  const legacyChat = seedChat(sqlite, {
    title: "From before attribution",
    accountId: null,
    spaceId: standInId,
    folderId: empty.id,
    legacyUnattributed: 1,
  });

  signIn(db, "a", W1_ACTIVE);
  db.claimSignedOutLocalRows();
  db.claimLegacyRowsOfOnlyAccount();
  assert.deepEqual(db.claimSignedOutPrivateNotes(), { notes: 3, folders: 1 });

  const aMeetings = db.getMeetingsFolder().id;
  assert.notEqual(aMeetings, seeded[1]);
  assert.deepEqual(
    {
      ...sqlite
        .prepare("SELECT space_id, folder_id, account_id FROM notes WHERE id = ?")
        .get(meeting.id),
    },
    { space_id: home, folder_id: aMeetings, account_id: "a" }
  );
  assert.deepEqual(
    {
      ...sqlite
        .prepare("SELECT space_id, folder_id, account_id, cloud_id FROM notes WHERE id = ?")
        .get(root),
    },
    { space_id: home, folder_id: null, account_id: "a", cloud_id: "cloud-root" }
  );
  const movedIdeas = folderRow(sqlite, ideas.id);
  assert.deepEqual(
    {
      space_id: movedIdeas.space_id,
      account_id: movedIdeas.account_id,
      name: movedIdeas.name,
      client_folder_id: movedIdeas.client_folder_id,
    },
    { space_id: home, account_id: "a", name: "Ideas (2)", client_folder_id: ideas.client_folder_id }
  );
  assert.equal(folderRow(sqlite, aIdeas.id).name, "Ideas");
  assert.equal(noteRow(sqlite, idea.id).space_id, home);
  assert.equal(noteRow(sqlite, idea.id).folder_id, ideas.id);
  for (const id of [...seeded, empty.id]) {
    assert.deepEqual(
      { space_id: folderRow(sqlite, id).space_id, account_id: folderRow(sqlite, id).account_id },
      { space_id: standInId, account_id: null },
      `folder ${id} stays in the stand-in`
    );
  }
  assert.deepEqual(chatRow(sqlite, rootChat.id), {
    space_id: home,
    folder_id: null,
    account_id: "a",
  });
  assert.deepEqual(chatRow(sqlite, meetingsChat.id), {
    space_id: home,
    folder_id: aMeetings,
    account_id: "a",
  });
  assert.deepEqual(chatRow(sqlite, ideasChat.id), {
    space_id: home,
    folder_id: ideas.id,
    account_id: "a",
  });
  assert.deepEqual(chatRow(sqlite, legacyChat), {
    space_id: home,
    folder_id: null,
    account_id: "a",
  });
  for (const id of [meeting.id, root, idea.id])
    assert.ok(db.getNote(id), `note ${id} is the account's`);
  assertEveryRowInItsFolderSpace(sqlite);

  assert.deepEqual(db.claimSignedOutPrivateNotes(), { notes: 0, folders: 0 }, "nothing is left");
});

test("claimSignedOutPrivateNotes leaves them on a device another account has used", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  signIn(db, "b");
  signIn(db, null);
  const note = db.saveNote("Signed out", "").note;
  const chat = db.createAgentConversation("Signed-out chat", null, standInId);

  signIn(db, "a", W1_ACTIVE);
  db.claimSignedOutLocalRows();
  assert.deepEqual(db.claimSignedOutPrivateNotes(), { notes: 0, folders: 0 });
  assert.deepEqual(
    { space_id: noteRow(db.db, note.id).space_id, account_id: noteRow(db.db, note.id).account_id },
    { space_id: standInId, account_id: null }
  );
  assert.equal(db.getNote(note.id), null);
  // #2924 gave the chat to this account at sign-in, so it leaves the stand-in.
  assert.deepEqual(chatRow(db.db, chat.id), {
    space_id: db.getDefaultPrivateSpaceId(),
    folder_id: null,
    account_id: "a",
  });

  signIn(db, null);
  assert.ok(db.getNote(note.id), "still there signed out");
});

test("saveNote without a space lands in the active workspace's Private, in its own Meetings folder", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  const standInMeetings = seededFolderId(db.db, "Meetings");
  signIn(db, "a", W2_ACTIVE);
  const w2 = db.getPrivateSpaceId();

  const meeting = db.saveNote("Standup", "", "meeting").note;
  assert.equal(meeting.space_id, w2);
  assert.equal(meeting.account_id, "a");
  const meetings = folderRow(db.db, meeting.folder_id);
  assert.deepEqual(
    {
      name: meetings.name,
      is_default: meetings.is_default,
      space_id: meetings.space_id,
      account_id: meetings.account_id,
    },
    { name: "Meetings", is_default: 1, space_id: w2, account_id: "a" }
  );
  assert.notEqual(meeting.folder_id, standInMeetings);
  assert.equal(db.getMeetingsFolder().id, meeting.folder_id);
  const personal = db.saveNote("Idea", "").note;
  assert.equal(folderRow(db.db, personal.folder_id).name, "Personal");
  assert.equal(personal.space_id, w2);

  // An existing default is reused: nothing is made twice.
  db.ensureDefaultFolders(w2);
  assert.equal(
    db.db
      .prepare(
        "SELECT COUNT(*) AS count FROM folders WHERE space_id = ? AND name IN ('Personal', 'Meetings')"
      )
      .get(w2).count,
    2
  );
  assert.equal(db.createFolder("Projects").folder.space_id, w2);
  const imported = db.importNotes([
    {
      clientNoteId: "granola-1",
      title: "Imported",
      content: "",
      sourceFile: null,
      transcript: null,
      participants: null,
      createdAt: null,
    },
  ]);
  assert.equal(imported.imported, 1);
  assert.equal(
    db.db.prepare("SELECT space_id FROM notes WHERE client_note_id = 'granola-1'").get().space_id,
    w2
  );
  assert.equal(folderRow(db.db, standInMeetings).space_id, db._standInPrivateSpaceId());
});

test("deleteAccountData removes the account's private space rows", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  const standInId = db._standInPrivateSpaceId();
  signIn(db, "b");
  const bNote = db.saveNote("B's note", "").note;
  signIn(db, "a", W2_ACTIVE);
  const aW2 = db.getPrivateSpaceId();
  const aDefault = db.getDefaultPrivateSpaceId();
  const aNote = db.saveNote("A's note", "", "meeting").note;
  const aChat = db.createAgentConversation("A's chat", null, aDefault);

  const result = db.deleteAccountData("a");

  assert.ok(result.deletedNoteIds.includes(aNote.id));
  assert.deepEqual(
    db.db.prepare("SELECT id FROM spaces WHERE account_id = 'a'").all(),
    [],
    "every private row of the account goes"
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM spaces WHERE id IN (?, ?)").get(aW2, aDefault)
      .count,
    0
  );
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM folders WHERE space_id IN (?, ?)")
      .get(aW2, aDefault).count,
    0
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE id = ?").get(aChat.id)
      .count,
    0
  );
  assert.ok(noteRow(db.db, bNote.id), "another account's note stays");
  assert.ok(spaceIdentity(db.db, bNote.space_id).kind === "private");
  assert.ok(spaceIdentity(db.db, standInId).kind === "private");
});

test("a folder delete the split left in the stand-in still finishes or rolls back once signed in", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  const sqlite = db.db;
  const standInId = db._standInPrivateSpaceId();
  signIn(db, "b");
  signIn(db, null);
  const journal = sqlite.prepare(
    `INSERT INTO optimistic_folder_delete_rows
       (folder_id, entity_type, entity_id, original_sync_status, original_deleted_at, original_updated_at)
     VALUES (?, ?, ?, 'synced', NULL, ?)`
  );
  // Deleted by account a before the split; a legacy note shared the folder, so
  // the split kept it whole in the stand-in.
  const heldFolder = () => {
    const folder = seedFolder(sqlite, standInId, {
      name: `Shared ${randomUUID()}`,
      cloudId: randomUUID(),
    });
    const notes = [
      seedNote(sqlite, standInId, { title: "legacy", folderId: folder, cloudId: randomUUID() }),
      seedNote(sqlite, standInId, {
        title: "a's",
        accountId: "a",
        folderId: folder,
        cloudId: randomUUID(),
      }),
    ];
    journal.run(folder, "folder", folder, SEEDED_AT);
    for (const id of notes) {
      journal.run(folder, "note", id, SEEDED_AT);
      sqlite
        .prepare(
          "UPDATE notes SET deleted_at = datetime('now'), sync_status = 'folder_delete_pending' WHERE id = ?"
        )
        .run(id);
    }
    sqlite
      .prepare(
        "UPDATE folders SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id = ?"
      )
      .run(folder);
    return { folder, notes };
  };
  const confirmed = heldFolder();
  const denied = heldFolder();
  const live = seedFolder(sqlite, standInId, { name: "Live", cloudId: "cf-live" });

  // An account with nothing in them can't push their delete.
  signIn(db, "b");
  assert.deepEqual(db.getPendingFolderDeletes(), []);
  assert.equal(db.hardDeleteFolder(confirmed.folder).success, false);

  signIn(db, "a", W1_ACTIVE);
  const pendingDeletes = db.getPendingFolderDeletes().map((folder) => folder.id);
  assert.ok(pendingDeletes.includes(confirmed.folder));
  assert.ok(pendingDeletes.includes(denied.folder));
  assert.equal(pendingDeletes.includes(live), false);

  assert.equal(db.hardDeleteFolder(confirmed.folder).success, true);
  assert.equal(folderRow(sqlite, confirmed.folder), undefined);
  for (const id of confirmed.notes) assert.equal(noteRow(sqlite, id), undefined);

  assert.equal(db.restoreFolderAfterDeniedDelete(denied.folder).success, true);
  assert.equal(folderRow(sqlite, denied.folder).deleted_at, null);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM optimistic_folder_delete_rows").get().count,
    0
  );

  // A live stand-in folder stays out of the signed-in account's reach.
  assert.equal(db.deleteFolder(live).success, false);
  assert.equal(db.hardDeleteFolder(live).success, false);
});

// Every account folder and private row in the account's own spaces, by name.
function accountFolderNames(sqlite, accountId) {
  return sqlite
    .prepare(
      `SELECT f.name FROM folders f JOIN spaces s ON s.id = f.space_id
       WHERE s.kind = 'private' AND s.account_id = ? AND f.deleted_at IS NULL
       ORDER BY f.name`
    )
    .all(accountId)
    .map((row) => row.name);
}

function retiredPrivateRows(sqlite) {
  return sqlite
    .prepare(
      "SELECT COUNT(*) AS count FROM spaces WHERE kind = 'private' AND deleted_at IS NOT NULL"
    )
    .get().count;
}

// What main does at sign-in, the spaces the window loads, then what the
// renderer sends once its workspace list is known.
function signInAsRendererDoes(db, accountId, defaultWorkspaceId) {
  db.setActiveAccountId(accountId);
  db.claimSignedOutLocalRows();
  db.claimLegacyRowsOfOnlyAccount();
  db.claimSignedOutPrivateNotes();
  db.getSpaces();
  db.setActiveWorkspaceScope({ activeWorkspaceId: defaultWorkspaceId, defaultWorkspaceId });
  db.bindDefaultPrivateSpace(defaultWorkspaceId);
}

test("an account that bound its default before finds that row again at the next sign-in", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  signInAsRendererDoes(db, "a", "w1");
  const home = db.getDefaultPrivateSpaceId();
  const ownMeeting = db.saveNote("A's meeting", "", "meeting").note;
  signIn(db, null);
  const signedOutMeeting = db.saveNote("Recorded signed out", "", "meeting").note;

  signInAsRendererDoes(db, "a", "w1");

  assert.equal(db.getDefaultPrivateSpaceId(), home);
  assert.deepEqual(
    {
      space_id: noteRow(db.db, signedOutMeeting.id).space_id,
      folder_id: noteRow(db.db, signedOutMeeting.id).folder_id,
      account_id: noteRow(db.db, signedOutMeeting.id).account_id,
    },
    { space_id: home, folder_id: ownMeeting.folder_id, account_id: "a" },
    "the signed-out meeting joins the account's own Meetings"
  );
  assert.deepEqual(accountFolderNames(db.db, "a"), ["Meetings", "Personal"]);
  assert.equal(pendingRowId(db.db, "a"), undefined, "no pending row is made again");
  assert.equal(retiredPrivateRows(db.db), 0, "and none is left behind");
});

test("a relaunch that asks for the Meetings folder before the bind makes no second set", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  signInAsRendererDoes(db, "a", "w1");
  const home = db.getDefaultPrivateSpaceId();
  const meetings = db.saveNote("A's meeting", "", "meeting").note.folder_id;
  db.db.close();

  const relaunched = relaunch(t);
  relaunched.setActiveAccountId("a");
  assert.equal(relaunched.getMeetingsFolder().id, meetings);
  assert.equal(relaunched.getDefaultPrivateSpaceId(), home);
  relaunched.setActiveWorkspaceScope(W1_ACTIVE);
  relaunched.bindDefaultPrivateSpace("w1");

  assert.deepEqual(accountFolderNames(relaunched.db, "a"), ["Meetings", "Personal"]);
  assert.equal(pendingRowId(relaunched.db, "a"), undefined);
  assert.equal(retiredPrivateRows(relaunched.db), 0);
});

test("a new default workspace takes the default; the old one keeps its Private", (t) => {
  const db = createFreshDeviceDb(t);
  if (!db) return;
  signInAsRendererDoes(db, "a", "w1");
  const w1 = db.getDefaultPrivateSpaceId();
  const w1Note = db.saveNote("Kept in w1", "").note;

  // Ownership of w1 was transferred; the server made w2 the new default.
  db.setActiveWorkspaceScope({ activeWorkspaceId: "w2", defaultWorkspaceId: "w2" });
  db.bindDefaultPrivateSpace("w2");
  const w2 = db.getDefaultPrivateSpaceId();

  assert.notEqual(w2, w1);
  assert.deepEqual(spaceIdentity(db.db, w2), {
    kind: "private",
    account_id: "a",
    workspace_id: "w2",
    deleted_at: null,
  });
  assert.deepEqual(spaceIdentity(db.db, w1), {
    kind: "private",
    account_id: "a",
    workspace_id: "w1",
    deleted_at: null,
  });
  assert.equal(noteRow(db.db, w1Note.id).space_id, w1, "w1's Private stays where it was");
  assert.equal(db.getPrivateSpaceId("w1"), w1);

  // After an account change the default is found without the renderer's scope.
  signIn(db, "b");
  signIn(db, "a");
  assert.equal(db.getDefaultPrivateSpaceId(), w2);
  assert.equal(db.getPrivateSpaceId(), w2);
  assert.equal(pendingRowId(db.db, "a"), undefined);
});
