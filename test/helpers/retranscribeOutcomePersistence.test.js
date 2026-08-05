const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-retranscribe-outcome-"));
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

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-retranscribe-outcome-"));
  return new DatabaseManager();
}

// updateNote silently ignores any field missing from its allowlist, so a new column can
// look wired up while every write is a no-op.
test("retranscribe_outcome round-trips through updateNote and getNote", () => {
  const db = createDb();
  const note = db.saveNote("Weekly sync", "body").note;

  assert.equal(db.getNote(note.id).retranscribe_outcome ?? null, null);

  db.updateNote(note.id, { retranscribe_outcome: "incomplete-source-coverage" });

  assert.equal(db.getNote(note.id).retranscribe_outcome, "incomplete-source-coverage");

  db.updateNote(note.id, { retranscribe_outcome: null });
  assert.equal(db.getNote(note.id).retranscribe_outcome ?? null, null);
});

test("pruneNoteSpeakerEmbeddings keeps only the speakers still in the transcript", () => {
  const db = createDb();
  const note = db.saveNote("Standup", "body").note;
  const insert = db.db.prepare(
    "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
  );
  insert.run(note.id, "speaker_0", Buffer.from([1, 2, 3, 4]));
  insert.run(note.id, "speaker_1", Buffer.from([5, 6, 7, 8]));
  insert.run(note.id, "speaker_2", Buffer.from([9, 10, 11, 12]));

  db.pruneNoteSpeakerEmbeddings(note.id, new Set(["speaker_0", "speaker_1"]));

  assert.deepEqual(
    db.getNoteSpeakerEmbeddings(note.id).map((row) => row.speaker_id).sort(),
    ["speaker_0", "speaker_1"]
  );
});

test("pruneNoteSpeakerEmbeddings with an empty keep set clears the note's rows only", () => {
  const db = createDb();
  const kept = db.saveNote("Other note", "body").note;
  const pruned = db.saveNote("Standup", "body").note;
  const insert = db.db.prepare(
    "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
  );
  insert.run(kept.id, "speaker_0", Buffer.from([1, 2, 3, 4]));
  insert.run(pruned.id, "speaker_0", Buffer.from([1, 2, 3, 4]));

  db.pruneNoteSpeakerEmbeddings(pruned.id, new Set());

  assert.equal(db.getNoteSpeakerEmbeddings(pruned.id).length, 0);
  assert.equal(db.getNoteSpeakerEmbeddings(kept.id).length, 1);
});
