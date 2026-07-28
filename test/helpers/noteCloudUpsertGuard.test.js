const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-sync-db-"));
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
const loadGuards = () => import("../../src/helpers/cloudSyncGuards.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-sync-db-"));
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

// Regression for #1290: a meeting note is created as an empty shell locally and
// in the cloud, the user's transcript and notes are saved locally, and a sync
// pull elects the still-empty cloud shell (its ISO timestamp lexically beats
// the local SQLite-format timestamp) and overwrites the local edit wholesale.

const TRANSCRIPT = JSON.stringify([{ text: "T".repeat(70000), source: "system", timestamp: 1 }]);

// The shell exactly as meetingDetectionEngine creates it, then the user's edit
// via the real save path. Returns the edited local row (sync_status pending,
// SQLite-format updated_at).
function seedEditedMeetingNote(db) {
  const saved = db.saveNote("Gabriel / Joshua", "", "meeting");
  const shell = saved.note || saved;
  db.updateNote(shell.id, {
    title: "Vision, Values, and Product Priorities",
    content: "REAL MEETING NOTES",
    enhanced_content: "ENHANCED NOTES",
    enhancement_prompt: "summarize the meeting",
    enhanced_at_content_hash: "hash-of-real-notes",
    transcript: TRANSCRIPT,
    cloud_id: "cloud-test-1",
  });
  return db.getNote(shell.id);
}

// The cloud's copy: the empty shell, stamped at the local edit's UTC midnight
// — older in real time (same instant at worst, if the edit lands exactly at
// 00:00:00) but with an ISO timestamp ('T' at index 10) that lexically beats
// the local SQLite format (' ' at index 10).
function emptyCloudShell(local) {
  const today = local.updated_at.slice(0, 10);
  return {
    id: "cloud-test-1",
    client_note_id: local.client_note_id,
    title: "Gabriel / Joshua",
    content: "",
    enhanced_content: null,
    transcript: null,
    note_type: "meeting",
    folder_id: null,
    source_file: null,
    audio_duration_seconds: null,
    enhancement_prompt: null,
    enhanced_at_content_hash: null,
    participants: JSON.stringify([{ email: "test@example.com" }]),
    calendar_event_id: "cal-ev-1",
    diarization_enabled: null,
    expected_speaker_count: null,
    deleted_at: null,
    created_at: `${today}T00:00:00.000Z`,
    updated_at: `${today}T00:00:00.000Z`,
  };
}

test("pull gate: an hours-older empty cloud shell is not elected over a fresh local edit", async (t) => {
  const db = createDb(t);
  if (!db) return;

  const local = seedEditedMeetingNote(db);
  assert.match(
    local.updated_at,
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/,
    "premise: local edits carry SQLite-format updated_at"
  );
  assert.equal(local.sync_status, "pending");

  const cloudNote = emptyCloudShell(local);
  assert.equal(
    cloudNote.updated_at > local.updated_at,
    true,
    "premise: the raw lexical compare would elect the hours-older cloud shell"
  );

  const { isCloudEntryNewer } = await loadGuards();
  assert.equal(
    isCloudEntryNewer(cloudNote.updated_at, local.updated_at),
    false,
    "the normalized pull gate must not elect the hours-older empty cloud shell"
  );
});

test("upsertNoteFromCloud: empty cloud values never destroy non-empty local content", (t) => {
  const db = createDb(t);
  if (!db) return;

  const before = seedEditedMeetingNote(db);
  db.upsertNoteFromCloud(emptyCloudShell(before), null);
  const after = db.getNote(before.id);

  assert.equal(after.content, "REAL MEETING NOTES", "content must survive an empty cloud copy");
  assert.equal(after.transcript, TRANSCRIPT, "transcript must survive an empty cloud copy");
  assert.equal(
    after.enhanced_content,
    "ENHANCED NOTES",
    "enhanced_content must survive an empty cloud copy"
  );
  assert.equal(
    after.enhancement_prompt,
    "summarize the meeting",
    "enhancement_prompt must travel with the preserved enhanced_content"
  );
  assert.equal(
    after.enhanced_at_content_hash,
    "hash-of-real-notes",
    "enhanced_at_content_hash must travel with the preserved enhanced_content (staleness detection breaks without it)"
  );
  assert.ok(after.participants, "participants still preserved (COALESCE)");
  assert.equal(after.calendar_event_id, "cal-ev-1", "calendar_event_id still preserved (COALESCE)");
});

test("upsertNoteFromCloud: non-empty cloud values still overwrite (last-writer-wins intact)", (t) => {
  const db = createDb(t);
  if (!db) return;

  const before = seedEditedMeetingNote(db);
  const cloudNote = {
    ...emptyCloudShell(before),
    title: "Cloud Title",
    content: "CLOUD EDIT",
    enhanced_content: "CLOUD ENHANCED",
    transcript: '[{"text":"cloud"}]',
  };
  db.upsertNoteFromCloud(cloudNote, null);
  const after = db.getNote(before.id);

  assert.equal(after.title, "Cloud Title");
  assert.equal(after.content, "CLOUD EDIT");
  assert.equal(after.enhanced_content, "CLOUD ENHANCED");
  assert.equal(after.transcript, '[{"text":"cloud"}]');
  assert.equal(
    after.enhancement_prompt,
    null,
    "a non-empty cloud enhancement brings its own prompt/hash (null here)"
  );
  assert.equal(after.sync_status, "synced");
});

test("upsertNoteFromCloud: a brand-new empty cloud note still inserts as-is", (t) => {
  const db = createDb(t);
  if (!db) return;

  const cloudNote = {
    id: "cloud-new-1",
    client_note_id: "client-new-1",
    title: "Fresh from cloud",
    content: "",
    enhanced_content: null,
    transcript: null,
    note_type: "personal",
    folder_id: null,
    source_file: null,
    audio_duration_seconds: null,
    enhancement_prompt: null,
    enhanced_at_content_hash: null,
    participants: null,
    calendar_event_id: null,
    diarization_enabled: null,
    expected_speaker_count: null,
    deleted_at: null,
    created_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
  };
  const row = db.upsertNoteFromCloud(cloudNote, null);

  assert.equal(row.title, "Fresh from cloud");
  assert.equal(row.content, "");
  assert.equal(row.sync_status, "synced");
});
