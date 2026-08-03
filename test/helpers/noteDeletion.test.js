const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-delete-"));
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

function freshUserDataDir() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-delete-"));
  return userDataDir;
}

function createDb() {
  requireSqlite();
  freshUserDataDir();
  return new DatabaseManager();
}

function count(db, sql, ...args) {
  return db.db.prepare(sql).get(...args).c;
}

function noteWithAttachments(db) {
  const note = db.saveNote("Quarterly revenue", "confidential body text").note;
  db.db
    .prepare("INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)")
    .run(note.id, "speaker_0", Buffer.from([1, 2, 3]));
  db.db
    .prepare("INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, ?, ?)")
    .run(note.id, "speaker_0", "Alice");
  const conversation = db.createAgentConversation("About the note", note.id);
  db.addAgentMessage(conversation.id, "user", "summarize this");
  return { note, conversation };
}

test("deleteNote removes the row outright instead of tombstoning it", () => {
  const db = createDb();
  const { note } = noteWithAttachments(db);

  assert.equal(db.deleteNote(note.id).success, true);

  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM notes WHERE id = ?", note.id),
    0,
    "no hidden tombstone row may be left behind"
  );
  assert.equal(db.getNote(note.id) ?? null, null);
});

test("deleteNote purges the note from the full-text index", () => {
  const db = createDb();
  const { note } = noteWithAttachments(db);

  db.deleteNote(note.id);

  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM notes_fts WHERE notes_fts MATCH 'revenue'"),
    0,
    "deleted note content must not survive in the FTS index"
  );
});

test("deleteNote cascades speaker mappings and embeddings", () => {
  const db = createDb();
  const { note } = noteWithAttachments(db);

  db.deleteNote(note.id);

  assert.equal(count(db, "SELECT COUNT(*) AS c FROM speaker_mappings WHERE note_id = ?", note.id), 0);
  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM note_speaker_embeddings WHERE note_id = ?", note.id),
    0
  );
});

test("deleteNote removes conversations attached to the note and their messages", () => {
  const db = createDb();
  const { note, conversation } = noteWithAttachments(db);

  db.deleteNote(note.id);

  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM agent_conversations WHERE note_id = ?", note.id),
    0,
    "a conversation must not dangle against a note that no longer exists"
  );
  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM agent_messages WHERE conversation_id = ?", conversation.id),
    0
  );
});

test("deleteNote leaves standalone conversations alone", () => {
  const db = createDb();
  const { note } = noteWithAttachments(db);
  const standalone = db.createAgentConversation("Unrelated chat", null);

  db.deleteNote(note.id);

  assert.equal(count(db, "SELECT COUNT(*) AS c FROM agent_conversations WHERE id = ?", standalone.id), 1);
});

test("deleteNote reports failure for an unknown id", () => {
  const db = createDb();
  assert.equal(db.deleteNote(999999).success, false);
});

test("deleteAgentConversation hard-deletes and cascades its messages", () => {
  const db = createDb();
  const conversation = db.createAgentConversation("Standalone", null);
  db.addAgentMessage(conversation.id, "user", "hello");
  db.addAgentMessage(conversation.id, "assistant", "hi");

  assert.equal(db.deleteAgentConversation(conversation.id).success, true);

  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM agent_conversations WHERE id = ?", conversation.id),
    0
  );
  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM agent_messages WHERE conversation_id = ?", conversation.id),
    0
  );
});

test("deleteFolder leaves no conversations dangling against its notes", () => {
  const db = createDb();
  const folder = db.createFolder("Archive").folder;
  const note = db.saveNote("In folder", "body", "personal", null, null, folder.id).note;
  const conversation = db.createAgentConversation("About it", note.id);
  db.addAgentMessage(conversation.id, "user", "hi");

  db.deleteFolder(folder.id);

  assert.equal(count(db, "SELECT COUNT(*) AS c FROM notes WHERE id = ?", note.id), 0);
  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM agent_conversations WHERE note_id = ?", note.id),
    0,
    "deleting a folder must not leave conversations pointing at vanished notes"
  );
  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM agent_messages WHERE conversation_id = ?", conversation.id),
    0
  );
});

test("startup purge drains tombstones left behind by the cloud era", () => {
  const BetterSqlite = requireSqlite();
  const dir = freshUserDataDir();
  const legacy = new BetterSqlite(path.join(dir, "transcriptions.db"));
  legacy.exec(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT,
      note_type TEXT DEFAULT 'personal',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );
    CREATE TABLE agent_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'Untitled',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );
    INSERT INTO notes (title, content, deleted_at) VALUES ('gone', 'x', '2026-01-01 00:00:00');
    INSERT INTO notes (title, content) VALUES ('kept', 'y');
    INSERT INTO agent_conversations (title, deleted_at) VALUES ('gone', '2026-01-01 00:00:00');
    INSERT INTO agent_conversations (title) VALUES ('kept');
  `);
  legacy.close();

  const db = new DatabaseManager();

  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NOT NULL"),
    0,
    "pre-existing note tombstones must be drained on open"
  );
  assert.equal(
    count(db, "SELECT COUNT(*) AS c FROM agent_conversations WHERE deleted_at IS NOT NULL"),
    0
  );
  assert.equal(count(db, "SELECT COUNT(*) AS c FROM notes"), 1, "live rows survive the purge");
  assert.equal(db.db.prepare("SELECT title FROM notes").get().title, "kept");
});
