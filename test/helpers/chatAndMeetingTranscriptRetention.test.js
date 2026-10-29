const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-history-retention-db-"));
const sent = [];
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: { send: (channel, data) => sent.push({ channel, data }) },
          },
        ],
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const IPCHandlers = require("../../src/helpers/ipcHandlers");
const markdownMirror = require("../../src/helpers/markdownMirror");
const {
  DEFAULT_RETENTION_SETTINGS,
  applyRetentionSettings,
} = require("../../src/helpers/retentionSettings");

const TRANSCRIPT = JSON.stringify([
  { id: "segment-0", text: "Welcome, everyone", speaker: "SPEAKER_00", timestamp: 0 },
]);

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-history-retention-db-"));
  sent.length = 0;
  try {
    const db = new DatabaseManager();
    db.setActiveAccountId("test-account");
    return db;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

function insertChat(db, { activeDaysAgo, startedDaysAgo = activeDaysAgo, cloudId = null }) {
  const { lastInsertRowid } = db.db
    .prepare(
      `INSERT INTO agent_conversations (title, created_at, updated_at, cloud_id)
       VALUES ('Offsite plans', datetime('now', ?), datetime('now', ?), ?)`
    )
    .run(`-${startedDaysAgo} days`, `-${activeDaysAgo} days`, cloudId);
  db.db
    .prepare(
      `INSERT INTO agent_messages (conversation_id, role, content)
       VALUES (?, 'user', 'Book a venue')`
    )
    .run(lastInsertRowid);
  return lastInsertRowid;
}

function chatRow(db, id) {
  return db.db.prepare("SELECT * FROM agent_conversations WHERE id = ?").get(id);
}

function messageCount(db, id) {
  return db.db
    .prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?")
    .get(id).count;
}

function createTeamSpace(db) {
  const { lastInsertRowid } = db.db
    .prepare(
      `INSERT INTO spaces (client_space_id, kind, name, sort_order)
       VALUES ('team-1', 'team', 'Team', 1)`
    )
    .run();
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, 'test-account')")
    .run(lastInsertRowid);
  return lastInsertRowid;
}

function insertNote(db, { daysAgo, noteType = "meeting", spaceId = null }) {
  const { note } = db.saveNote("Weekly sync", "My own notes", noteType, null, null, null, spaceId);
  db.db
    .prepare(
      `UPDATE notes SET transcript = ?, enhanced_content = 'Summary', sync_status = 'synced',
         created_at = datetime('now', ?), updated_at = datetime('now', ?)
       WHERE id = ?`
    )
    .run(TRANSCRIPT, `-${daysAgo} days`, `-${daysAgo} days`, note.id);
  db.setSpeakerMapping(note.id, "SPEAKER_00", null, "Dana");
  db.saveNoteSpeakerEmbeddings(note.id, { SPEAKER_00: Buffer.from([1, 2, 3, 4]) });
  return note.id;
}

function noteRow(db, id) {
  return db.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}

function speakerRowCount(db, id) {
  const count = (table) =>
    db.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE note_id = ?`).get(id).count;
  return count("speaker_mappings") + count("note_speaker_embeddings");
}

function cleanup(db, settings, overrides = {}) {
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), {
    databaseManager: db,
    audioStorageManager: { deleteAudio() {}, cleanupExpiredAudio() {} },
    _retentionSettings: { ...DEFAULT_RETENTION_SETTINGS, ...settings },
    _noteFilesEnabled: false,
    ...overrides,
  });
  handlers._runRetentionCleanup();
}

test("a chat with no activity within the period is removed and a recent one kept", (t) => {
  const db = createDb(t);
  if (!db) return;

  const stale = insertChat(db, { activeDaysAgo: 10 });
  const recent = insertChat(db, { activeDaysAgo: 1 });

  const { ids } = db.deleteConversationsExpiredBefore(7);

  assert.deepEqual(ids, [stale]);
  assert.equal(chatRow(db, stale), undefined);
  assert.equal(messageCount(db, stale), 0);
  assert.equal(chatRow(db, recent).deleted_at, null);
  assert.equal(messageCount(db, recent), 1);
});

test("a synced chat is tombstoned for the cloud delete and its messages removed", (t) => {
  const db = createDb(t);
  if (!db) return;

  const synced = insertChat(db, { activeDaysAgo: 10, cloudId: "cloud-chat-1" });

  db.deleteConversationsExpiredBefore(7);

  const row = chatRow(db, synced);
  assert.notEqual(row.deleted_at, null);
  assert.equal(row.sync_status, "pending");
  assert.equal(messageCount(db, synced), 0);
});

test("a chat started long ago but used recently is kept", (t) => {
  const db = createDb(t);
  if (!db) return;

  const ongoing = insertChat(db, { startedDaysAgo: 60, activeDaysAgo: 1 });

  assert.deepEqual(db.deleteConversationsExpiredBefore(30).ids, []);
  assert.equal(chatRow(db, ongoing).deleted_at, null);
});

test("the chat count shown before a shorter period matches what the clean-up removes", (t) => {
  const db = createDb(t);
  if (!db) return;

  insertChat(db, { activeDaysAgo: 40 });
  insertChat(db, { activeDaysAgo: 35, cloudId: "cloud-chat-2" });
  insertChat(db, { activeDaysAgo: 2 });

  assert.equal(db.countConversationsExpiredBefore(30), 2);
  assert.equal(db.deleteConversationsExpiredBefore(30).ids.length, 2);
  assert.equal(db.countConversationsExpiredBefore(30), 0);
});

test("an old meeting transcript is cleared while the note, its notes and summary stay", (t) => {
  const db = createDb(t);
  if (!db) return;

  const old = insertNote(db, { daysAgo: 40 });
  const recent = insertNote(db, { daysAgo: 5 });

  const { ids } = db.clearMeetingTranscriptsExpiredBefore(30);

  assert.deepEqual(ids, [old]);
  const cleared = noteRow(db, old);
  assert.equal(cleared.transcript, null);
  assert.equal(cleared.content, "My own notes");
  assert.equal(cleared.enhanced_content, "Summary");
  assert.equal(cleared.deleted_at, null);
  assert.equal(speakerRowCount(db, old), 0);
  assert.equal(noteRow(db, recent).transcript, TRANSCRIPT);
  assert.equal(speakerRowCount(db, recent), 2);
});

test("a meeting note recorded into again recently keeps its transcript", (t) => {
  const db = createDb(t);
  if (!db) return;

  const resumed = insertNote(db, { daysAgo: 60 });
  // A recording resumed into the note today writes its transcript back.
  db.updateNote(resumed, { transcript: TRANSCRIPT });

  assert.deepEqual(db.clearMeetingTranscriptsExpiredBefore(30).ids, []);
  assert.equal(noteRow(db, resumed).transcript, TRANSCRIPT);
});

test("an imported meeting's transcript ages from the import, not the meeting date", (t) => {
  const db = createDb(t);
  if (!db) return;

  const meetingDate = "2025-03-04 15:00:00";
  const { noteIds } = db.importNotes([
    {
      clientNoteId: "9f0c6a52-5d1b-4f43-9a3e-2b7d0c1e8a41",
      sourceFile: "granola:quarterly-review",
      title: "Quarterly review",
      content: "Imported notes",
      transcript: TRANSCRIPT,
      participants: null,
      createdAt: meetingDate,
    },
  ]);
  const [imported] = noteIds;

  assert.equal(db.countMeetingTranscriptsExpiredBefore(30), 0);
  assert.deepEqual(db.clearMeetingTranscriptsExpiredBefore(30).ids, []);
  assert.equal(noteRow(db, imported).transcript, TRANSCRIPT);
  // The meeting keeps its own date, so its place in the notes list is unchanged.
  assert.equal(noteRow(db, imported).updated_at, meetingDate);

  // Forty days after the import, the period has passed.
  db.db
    .prepare("UPDATE notes SET imported_at = datetime('now', '-40 days') WHERE id = ?")
    .run(imported);
  assert.deepEqual(db.clearMeetingTranscriptsExpiredBefore(30).ids, [imported]);
});

test("clearing a meeting transcript queues nothing for cloud sync", (t) => {
  const db = createDb(t);
  if (!db) return;

  const old = insertNote(db, { daysAgo: 40 });
  const before = noteRow(db, old);

  db.clearMeetingTranscriptsExpiredBefore(30);

  const after = noteRow(db, old);
  assert.equal(after.sync_status, "synced");
  assert.equal(after.updated_at, before.updated_at);
});

test("a recording started from a new note loses its transcript after the period", (t) => {
  const db = createDb(t);
  if (!db) return;

  // New note saves a personal note and records into it.
  const recorded = insertNote(db, { daysAgo: 40, noteType: "personal" });

  assert.deepEqual(db.clearMeetingTranscriptsExpiredBefore(30).ids, [recorded]);
  assert.equal(noteRow(db, recorded).transcript, null);
  assert.equal(noteRow(db, recorded).content, "My own notes");
});

test("notes in team spaces and uploaded audio keep their transcripts", (t) => {
  const db = createDb(t);
  if (!db) return;

  const team = insertNote(db, { daysAgo: 40, spaceId: createTeamSpace(db) });
  const upload = insertNote(db, { daysAgo: 40, noteType: "upload" });

  assert.deepEqual(db.clearMeetingTranscriptsExpiredBefore(30).ids, []);
  assert.equal(noteRow(db, team).transcript, TRANSCRIPT);
  assert.equal(noteRow(db, upload).transcript, TRANSCRIPT);
});

test("another account's notes on this computer keep their transcripts", (t) => {
  const db = createDb(t);
  if (!db) return;

  const otherAccount = insertNote(db, { daysAgo: 40 });
  db.db.prepare("UPDATE notes SET account_id = 'other-account' WHERE id = ?").run(otherAccount);

  assert.deepEqual(db.clearMeetingTranscriptsExpiredBefore(30).ids, []);
  assert.equal(noteRow(db, otherAccount).transcript, TRANSCRIPT);
});

test("the transcript count shown before a shorter period matches what is cleared", (t) => {
  const db = createDb(t);
  if (!db) return;

  insertNote(db, { daysAgo: 40 });
  insertNote(db, { daysAgo: 31 });
  insertNote(db, { daysAgo: 3 });

  assert.equal(db.countMeetingTranscriptsExpiredBefore(30), 2);
  assert.equal(db.clearMeetingTranscriptsExpiredBefore(30).ids.length, 2);
  assert.equal(db.countMeetingTranscriptsExpiredBefore(30), 0);
});

test("the first clean-up after updating removes no chat or meeting transcript", (t) => {
  const db = createDb(t);
  if (!db) return;

  const chat = insertChat(db, { activeDaysAgo: 400 });
  const note = insertNote(db, { daysAgo: 400 });
  // What a profile from before these settings syncs on its first launch.
  const { settings } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    audioRetentionDays: 30,
    transcriptRetentionDays: 0,
  });

  cleanup(db, settings);

  assert.equal(chatRow(db, chat).deleted_at, null);
  assert.equal(noteRow(db, note).transcript, TRANSCRIPT);
});

test("the clean-up removes old chats and transcripts once a period is chosen", (t) => {
  const db = createDb(t);
  if (!db) return;

  const chats = [insertChat(db, { activeDaysAgo: 10 }), insertChat(db, { activeDaysAgo: 9 })];
  const notes = [insertNote(db, { daysAgo: 10 }), insertNote(db, { daysAgo: 9 })];

  cleanup(db, { chatRetentionDays: 7, meetingTranscriptRetentionDays: 7 });

  for (const chat of chats) assert.equal(chatRow(db, chat), undefined);
  for (const note of notes) assert.equal(noteRow(db, note).transcript, null);
  // One message per clean-up, not per item, so open windows refresh once.
  assert.deepEqual(
    sent.map(({ channel, data }) => [channel, [...data.ids].sort()]),
    [
      ["conversations-deleted", [...chats].sort()],
      ["note-transcripts-cleared", [...notes].sort()],
    ]
  );
});

test("a clean-up that removes nothing tells no window", (t) => {
  const db = createDb(t);
  if (!db) return;

  insertChat(db, { activeDaysAgo: 1 });
  insertNote(db, { daysAgo: 1 });

  cleanup(db, { chatRetentionDays: 7, meetingTranscriptRetentionDays: 7 });

  assert.deepEqual(sent, []);
});

test("a signed-in profile keeps chats and transcripts until its workspace policy is known", (t) => {
  const db = createDb(t);
  if (!db) return;

  const chat = insertChat(db, { activeDaysAgo: 10 });
  const note = insertNote(db, { daysAgo: 10 });
  const period = { chatRetentionDays: 7, meetingTranscriptRetentionDays: 7 };
  const signedIn = { _hasActiveAccountScope: () => true };

  cleanup(db, { ...period, localHistoryPolicyResolved: false }, signedIn);
  assert.equal(chatRow(db, chat).deleted_at, null);
  assert.equal(noteRow(db, note).transcript, TRANSCRIPT);

  cleanup(db, { ...period, localHistoryPolicyResolved: true }, signedIn);
  assert.equal(chatRow(db, chat), undefined);
  assert.equal(noteRow(db, note).transcript, null);
});

test("the preview counts what a shorter period would remove", (t) => {
  const db = createDb(t);
  if (!db) return;

  insertChat(db, { activeDaysAgo: 40 });
  insertNote(db, { daysAgo: 40 });
  insertNote(db, { daysAgo: 45 });
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager: db });

  assert.deepEqual(handlers._previewRetention("chats", 30), { count: 1 });
  assert.deepEqual(handlers._previewRetention("meetingTranscripts", 30), { count: 2 });
  for (const [kind, days] of [
    ["notes", 30],
    ["chats", 0],
    ["chats", "30"],
  ]) {
    assert.throws(() => handlers._previewRetention(kind, days), `${kind} ${days}`);
  }
});

test("a cleared transcript's Markdown copy is removed with it", (t) => {
  const db = createDb(t);
  if (!db) return;

  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-history-retention-md-"));
  t.after(() => fs.rmSync(mirrorDir, { recursive: true, force: true }));
  markdownMirror.init(mirrorDir);
  const note = insertNote(db, { daysAgo: 10 });
  markdownMirror.writeTranscript(noteRow(db, note), "Meetings", {});
  const transcriptFiles = () =>
    fs
      .readdirSync(path.join(mirrorDir, "Meetings"))
      .filter((file) => file.endsWith("-transcript.md"));
  assert.equal(transcriptFiles().length, 1);

  cleanup(db, { meetingTranscriptRetentionDays: 7 }, { _noteFilesEnabled: true });

  assert.deepEqual(transcriptFiles(), []);
});
