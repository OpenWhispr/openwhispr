const test = require("node:test");
const assert = require("node:assert/strict");

const {
  matchesMeetingNoteIdentity,
  persistMeetingDiarizationResult,
  resolveMeetingNoteIdentity,
  snapshotMeetingNoteIdentity,
} = require("../../src/helpers/meetingDiarizationPersistence");

const segment = (text, timestamp, extra = {}) => ({
  id: `live-${timestamp}`,
  text,
  source: "system",
  timestamp,
  ...extra,
});

const storedTranscript = (...segments) =>
  JSON.stringify(segments.map(({ id: _id, ...stored }) => stored));

function createDatabase(notes) {
  const rows = new Map(notes.map((note) => [note.id, structuredClone(note)]));
  const embeddings = new Map();
  const writes = [];

  return {
    getNote(id) {
      const row = rows.get(id);
      return row ? structuredClone(row) : null;
    },
    updateNote(id, updates) {
      const current = rows.get(id);
      if (!current) return { success: false };
      const note = { ...current, ...updates, sync_status: "pending" };
      rows.set(id, note);
      writes.push({ id, updates: structuredClone(updates) });
      return { success: true, note: structuredClone(note) };
    },
    saveNoteSpeakerEmbeddings(id, values) {
      embeddings.set(id, values);
    },
    read(id) {
      return structuredClone(rows.get(id));
    },
    embeddings,
    rows,
    writes,
  };
}

function note(id, clientNoteId, transcript = "[]") {
  return {
    id,
    client_note_id: clientNoteId,
    transcript,
    deleted_at: null,
    sync_status: "synced",
  };
}

test("snapshots both numeric and stable client identity for a live note", () => {
  const databaseManager = createDatabase([note(7, "client-a")]);

  assert.deepEqual(snapshotMeetingNoteIdentity(databaseManager, 7), {
    noteId: 7,
    clientNoteId: "client-a",
  });
  assert.equal(snapshotMeetingNoteIdentity(databaseManager, 99), null);
  assert.equal(
    matchesMeetingNoteIdentity(databaseManager, { noteId: 7, clientNoteId: "client-a" }),
    true
  );
  assert.equal(
    matchesMeetingNoteIdentity(databaseManager, { noteId: 7, clientNoteId: "replaced" }),
    false
  );
  assert.deepEqual(resolveMeetingNoteIdentity(databaseManager, 7, "client-a"), {
    noteId: 7,
    clientNoteId: "client-a",
  });
  assert.equal(resolveMeetingNoteIdentity(databaseManager, 7, "replaced"), null);
});

test("a delayed A completion changes only A while B is active", () => {
  const aBefore = storedTranscript(segment("A live", 1));
  const bBefore = storedTranscript(segment("B live", 2));
  const databaseManager = createDatabase([
    note(1, "client-a", aBefore),
    note(2, "client-b", bBefore),
  ]);

  const result = persistMeetingDiarizationResult({
    databaseManager,
    identity: { noteId: 1, clientNoteId: "client-a" },
    segments: [segment("A live", 1, { speaker: "speaker_0" })],
    speakerEmbeddings: { speaker_0: [0.25, 0.5] },
  });

  assert.equal(result.status, "persisted");
  assert.equal(JSON.parse(databaseManager.read(1).transcript)[0].speaker, "speaker_0");
  assert.equal(databaseManager.read(2).transcript, bBefore);
  assert.deepEqual(
    databaseManager.writes.map(({ id }) => id),
    [1]
  );
  assert.equal(databaseManager.embeddings.has(1), true);
  assert.equal(databaseManager.embeddings.has(2), false);
});

test("overlapping jobs remain isolated when B completes before A", () => {
  const databaseManager = createDatabase([
    note(1, "client-a", storedTranscript(segment("A", 1))),
    note(2, "client-b", storedTranscript(segment("B", 2))),
  ]);

  persistMeetingDiarizationResult({
    databaseManager,
    identity: { noteId: 2, clientNoteId: "client-b" },
    segments: [segment("B", 2, { speaker: "speaker_b" })],
  });
  persistMeetingDiarizationResult({
    databaseManager,
    identity: { noteId: 1, clientNoteId: "client-a" },
    segments: [segment("A", 1, { speaker: "speaker_a" })],
  });

  assert.equal(JSON.parse(databaseManager.read(1).transcript)[0].speaker, "speaker_a");
  assert.equal(JSON.parse(databaseManager.read(2).transcript)[0].speaker, "speaker_b");
  assert.deepEqual(
    databaseManager.writes.map(({ id }) => id),
    [2, 1]
  );
});

test("latest user speaker locks survive the background merge", () => {
  const locked = segment("Hello", 10, {
    speaker: "speaker_live",
    speakerName: "Alex",
    speakerStatus: "locked",
    speakerLocked: true,
    speakerLockSource: "user",
  });
  const databaseManager = createDatabase([note(1, "client-a", storedTranscript(locked))]);

  const result = persistMeetingDiarizationResult({
    databaseManager,
    identity: { noteId: 1, clientNoteId: "client-a" },
    segments: [
      segment("Hello", 10, {
        speaker: "speaker_diarized",
        speakerName: "Automatic guess",
        speakerStatus: "confirmed",
        speakerLocked: false,
      }),
    ],
  });

  assert.equal(result.status, "persisted");
  const [merged] = JSON.parse(databaseManager.read(1).transcript);
  assert.equal(merged.speaker, "speaker_diarized");
  assert.equal(merged.speakerName, "Alex");
  assert.equal(merged.speakerStatus, "locked");
  assert.equal(merged.speakerLocked, true);
  assert.equal(merged.speakerLockSource, "user");
});

test("missing, deleted, and replaced target identities are never written", () => {
  const deleted = { ...note(2, "client-deleted"), deleted_at: "2026-08-07T12:00:00Z" };
  const databaseManager = createDatabase([note(1, "client-new"), deleted]);

  const attempts = [
    { noteId: 99, clientNoteId: "missing" },
    { noteId: 2, clientNoteId: "client-deleted" },
    { noteId: 1, clientNoteId: "client-old" },
  ];
  const reasons = attempts.map(
    (identity) =>
      persistMeetingDiarizationResult({
        databaseManager,
        identity,
        segments: [segment("stale", 1)],
        speakerEmbeddings: { speaker_0: [1] },
      }).reason
  );

  assert.deepEqual(reasons, ["missing-note", "deleted-note", "identity-changed"]);
  assert.equal(databaseManager.writes.length, 0);
  assert.equal(databaseManager.embeddings.size, 0);
});

test("persistence has no renderer dependency and runs normal update hooks", () => {
  const databaseManager = createDatabase([note(1, "client-a")]);
  const updated = [];
  const embeddingTargets = [];

  const result = persistMeetingDiarizationResult({
    databaseManager,
    identity: { noteId: 1, clientNoteId: "client-a" },
    segments: [segment("offline completion", 1)],
    speakerEmbeddings: { speaker_0: [0.5] },
    onNoteUpdated: (value) => updated.push(value),
    onSpeakerEmbeddingsSaved: (identity) => embeddingTargets.push(identity),
  });

  assert.equal(result.status, "persisted");
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 1);
  assert.equal(updated[0].sync_status, "pending");
  assert.deepEqual(embeddingTargets, [{ noteId: 1, clientNoteId: "client-a" }]);
});

test("legacy and inferred speaker states use the renderer's canonical merge policy", () => {
  const databaseManager = createDatabase([
    note(
      1,
      "client-a",
      storedTranscript(
        segment("locked", 1, { speakerName: "Alex", speakerStatus: "user_locked" }),
        segment("suggested", 2, { suggestedName: "Richard", speakerStatus: "suggested_profile" }),
        segment("overlap", 3, { speakerStatus: "uncertain_overlap" }),
        segment("placeholder", 4, { speaker: "speaker_3", speakerIsPlaceholder: true })
      )
    ),
  ]);

  const result = persistMeetingDiarizationResult({
    databaseManager,
    identity: { noteId: 1, clientNoteId: "client-a" },
    segments: [
      segment("locked", 1, { speaker: "speaker_0" }),
      segment("suggested", 2, { speaker: "speaker_1" }),
      segment("overlap", 3, { speaker: "speaker_2" }),
      segment("placeholder", 4, { speaker: "speaker_3" }),
    ],
  });

  assert.equal(result.status, "persisted");
  const canonical = JSON.parse(databaseManager.read(1).transcript);
  assert.deepEqual(
    canonical.map(({ speakerStatus, speakerLocked, speakerLockSource }) => ({
      speakerStatus,
      speakerLocked,
      speakerLockSource,
    })),
    [
      { speakerStatus: "locked", speakerLocked: true, speakerLockSource: "user" },
      { speakerStatus: "suggested", speakerLocked: false, speakerLockSource: undefined },
      { speakerStatus: "provisional", speakerLocked: false, speakerLockSource: undefined },
      { speakerStatus: "provisional", speakerLocked: false, speakerLockSource: undefined },
    ]
  );
});

test("re-delivering the same completion is idempotent", () => {
  const databaseManager = createDatabase([
    note(1, "client-a", storedTranscript(segment("once", 1))),
  ]);
  const completion = {
    databaseManager,
    identity: { noteId: 1, clientNoteId: "client-a" },
    segments: [segment("once", 1, { speaker: "speaker_0" })],
  };

  persistMeetingDiarizationResult(completion);
  persistMeetingDiarizationResult(completion);

  const persisted = JSON.parse(databaseManager.read(1).transcript);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].speaker, "speaker_0");
});
