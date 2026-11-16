const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");
const { EMBEDDING_DIM, EMBEDDING_VERSION } = require("../../src/constants/speakerDetection.json");

// The embedding model before the zh-en CAM++ wrote 512 values.
const LEGACY_DIM = 512;
const voice = (dim, value) => Buffer.from(new Float32Array(dim).fill(value).buffer);
const valuesOf = (profile) =>
  new Float32Array(
    profile.embedding.buffer,
    profile.embedding.byteOffset,
    profile.embedding.byteLength / 4
  );

// A profile as an earlier build stored it, or one in the current version.
function insertProfile(db, name, { email = null, version = null, samples = 1, value = 1 } = {}) {
  const dim = version === EMBEDDING_VERSION ? EMBEDDING_DIM : LEGACY_DIM;
  return db.db
    .prepare(
      "INSERT INTO speaker_profiles (display_name, email, embedding, embedding_version, sample_count) VALUES (?, ?, ?, ?, ?)"
    )
    .run(name, email, voice(dim, value), version, samples).lastInsertRowid;
}

const profileRow = (db, id) => db.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(id);

test("a database from an earlier build gains the version column, its rows left stale", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Meeting", "", "meeting").note;
  db.db.exec("ALTER TABLE speaker_profiles DROP COLUMN embedding_version");
  db.db.exec("ALTER TABLE note_speaker_embeddings DROP COLUMN embedding_version");
  db.db
    .prepare("INSERT INTO speaker_profiles (display_name, embedding) VALUES (?, ?)")
    .run("Alice", voice(LEGACY_DIM, 1));
  db.db
    .prepare(
      "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
    )
    .run(note.id, "speaker_0", voice(LEGACY_DIM, 1));
  db.db.close();

  const upgraded = new DatabaseManager();
  t.after(() => upgraded.db.close());

  assert.equal(profileRow(upgraded, 1).embedding_version, null);
  assert.deepEqual(upgraded.getSpeakerProfiles(true), []);
  assert.deepEqual(
    upgraded.getSpeakerProfiles().map((profile) => profile.display_name),
    ["Alice"]
  );
  assert.deepEqual(upgraded.getNoteSpeakerEmbeddings(note.id), []);
});

test("only current-version voices are returned for matching", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Meeting", "", "meeting").note;
  insertProfile(db, "Stale");
  insertProfile(db, "Current", { version: EMBEDDING_VERSION });
  db.db
    .prepare(
      "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
    )
    .run(note.id, "speaker_0", voice(LEGACY_DIM, 1));
  db.saveNoteSpeakerEmbeddings(note.id, { speaker_1: voice(EMBEDDING_DIM, 1) });

  assert.deepEqual(
    db.getSpeakerProfiles(true).map((profile) => profile.display_name),
    ["Current"]
  );
  assert.equal(db.getSpeakerProfiles().length, 2);
  assert.deepEqual(
    db.getNoteSpeakerEmbeddings(note.id).map((row) => [row.speaker_id, row.embedding_version]),
    [["speaker_1", EMBEDDING_VERSION]]
  );
});

test("labeling a stale profile replaces its voice in place, then blends as before", (t) => {
  const db = createDb(t);
  if (!db) return;
  const id = insertProfile(db, "Alice", { email: "alice@example.com", samples: 12 });

  const enrolled = db.upsertSpeakerProfile("Alice", null, voice(EMBEDDING_DIM, 1));
  assert.equal(enrolled.id, id);
  assert.equal(enrolled.email, "alice@example.com");
  assert.equal(enrolled.embedding_version, EMBEDDING_VERSION);
  assert.equal(enrolled.sample_count, 1);
  assert.deepEqual([...new Set(valuesOf(enrolled))], [1]);

  const blended = db.upsertSpeakerProfile("Alice", null, voice(EMBEDDING_DIM, 0));
  assert.equal(blended.sample_count, 2);
  assert.equal(valuesOf(blended).length, EMBEDDING_DIM);
  assert.ok(Math.abs(valuesOf(blended)[0] - 0.7) < 1e-6);
});

// attachEmailToProfile merges the two profiles when the email belongs to another.
test("merging profiles keeps the current voice and never blends across versions", (t) => {
  const db = createDb(t);
  if (!db) return;

  const staleWinner = insertProfile(db, "Stale", { email: "a@example.com", samples: 10 });
  const currentLoser = insertProfile(db, "Current", { version: EMBEDDING_VERSION, samples: 2 });
  let merged = db.attachEmailToProfile(currentLoser, "a@example.com");
  assert.equal(merged.id, staleWinner);
  assert.equal(merged.embedding_version, EMBEDDING_VERSION);
  assert.equal(merged.sample_count, 2);
  assert.equal(valuesOf(merged).length, EMBEDDING_DIM);

  const stale = insertProfile(db, "Old", { email: "b@example.com", samples: 4 });
  const alsoStale = insertProfile(db, "Older", { samples: 6 });
  merged = db.attachEmailToProfile(alsoStale, "b@example.com");
  assert.equal(merged.id, alsoStale);
  assert.equal(merged.embedding_version, null);
  assert.equal(profileRow(db, stale), undefined);

  const first = insertProfile(db, "First", {
    email: "c@example.com",
    version: EMBEDDING_VERSION,
    samples: 1,
    value: 1,
  });
  const second = insertProfile(db, "Second", { version: EMBEDDING_VERSION, samples: 3, value: 0 });
  merged = db.attachEmailToProfile(second, "c@example.com");
  assert.equal(merged.sample_count, 4);
  assert.ok(Math.abs(valuesOf(merged)[0] - 0.25) < 1e-6);
  assert.equal(profileRow(db, first), undefined);
});

// A note recorded before the current embeddings has no voice to enroll.
test("a label without a voice links the person's profile and never creates one", (t) => {
  const db = createDb(t);
  if (!db) return;
  const alice = insertProfile(db, "Alice", { email: "alice@example.com" });
  const bob = insertProfile(db, "Bob");

  assert.equal(db.linkSpeakerProfile("Someone", null, alice).id, alice);
  assert.equal(db.linkSpeakerProfile("Ali", "Alice@Example.com").id, alice);
  assert.equal(db.linkSpeakerProfile("Bob", null).id, bob);
  assert.equal(db.linkSpeakerProfile("Carol", "carol@example.com"), null);
  assert.equal(db.getSpeakerProfiles().length, 2);

  const withEmail = db.linkSpeakerProfile("Bob", "bob@example.com");
  assert.equal(withEmail.id, bob);
  assert.equal(withEmail.email, "bob@example.com");
  assert.equal(profileRow(db, alice).display_name, "Alice");
});
