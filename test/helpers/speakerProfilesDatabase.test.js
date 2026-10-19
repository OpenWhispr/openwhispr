const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");

function embedding(index) {
  const values = new Float32Array(512);
  values[index] = 1;
  return Buffer.from(values.buffer);
}

test("same-name attendees with different emails keep separate speaker profiles", (t) => {
  const db = createDb(t);
  if (!db) return;

  const first = db.upsertSpeakerProfile("Alex Morgan", "alex@first.example", embedding(0));
  const second = db.upsertSpeakerProfile("Alex Morgan", "alex@second.example", embedding(1));

  assert.notEqual(second.id, first.id);
  const profiles = db.getSpeakerProfiles(true);
  assert.equal(profiles.length, 2);
  const savedFirst = profiles.find((profile) => profile.id === first.id);
  const savedSecond = profiles.find((profile) => profile.id === second.id);
  assert.equal(savedFirst.email, "alex@first.example");
  assert.equal(savedSecond.email, "alex@second.example");
  assert.deepEqual(savedFirst.embedding, embedding(0));
  assert.deepEqual(savedSecond.embedding, embedding(1));
  assert.equal(savedFirst.sample_count, 1);
  assert.equal(savedSecond.sample_count, 1);
});

test("normalized email reuses a profile when its display name changes", (t) => {
  const db = createDb(t);
  if (!db) return;

  const first = db.upsertSpeakerProfile("Alex", "alex@example.com", embedding(0));
  const updated = db.upsertSpeakerProfile("Alex Morgan", " ALEX@EXAMPLE.COM ", embedding(1));

  assert.equal(updated.id, first.id);
  assert.equal(updated.display_name, "Alex Morgan");
  assert.equal(updated.email, "alex@example.com");
  assert.equal(updated.sample_count, 2);
  assert.equal(db.getSpeakerProfiles().length, 1);
});

test("an email upgrades the same-name profile without an email", (t) => {
  const db = createDb(t);
  if (!db) return;

  const first = db.upsertSpeakerProfile("Alex", null, embedding(0));
  const updated = db.upsertSpeakerProfile("Alex", "alex@example.com", embedding(1));

  assert.equal(updated.id, first.id);
  assert.equal(updated.email, "alex@example.com");
  assert.equal(updated.sample_count, 2);
  assert.equal(db.getSpeakerProfiles().length, 1);
});

test("email upgrade finds an unbound profile after a same-name emailed profile", (t) => {
  const db = createDb(t);
  if (!db) return;

  const bound = db.upsertSpeakerProfile("Alex", "first@example.com", embedding(0));
  const unbound = db.upsertSpeakerProfile("Other name", null, embedding(1));
  db.upsertSpeakerProfile("Alex", null, embedding(1), unbound.id);
  const updated = db.upsertSpeakerProfile("Alex", "second@example.com", embedding(2));

  assert.equal(updated.id, unbound.id);
  const profiles = db.getSpeakerProfiles();
  assert.equal(profiles.length, 2);
  assert.equal(profiles.find((profile) => profile.id === bound.id).email, "first@example.com");
  assert.equal(updated.email, "second@example.com");
});

test("an explicit profile ID permits changing its email", (t) => {
  const db = createDb(t);
  if (!db) return;

  const first = db.upsertSpeakerProfile("Alex", "old@example.com", embedding(0));
  const updated = db.upsertSpeakerProfile("Alex Morgan", "new@example.com", embedding(1), first.id);

  assert.equal(updated.id, first.id);
  assert.equal(updated.email, "new@example.com");
  assert.equal(db.getSpeakerProfiles().length, 1);
});

test("enrollment without an email retains name-based profile reuse", (t) => {
  const db = createDb(t);
  if (!db) return;

  const first = db.upsertSpeakerProfile("Alex", "alex@example.com", embedding(0));
  const updated = db.upsertSpeakerProfile("Alex", null, embedding(1));

  assert.equal(updated.id, first.id);
  assert.equal(updated.email, "alex@example.com");
  assert.equal(updated.sample_count, 2);
  assert.equal(db.getSpeakerProfiles().length, 1);
});
