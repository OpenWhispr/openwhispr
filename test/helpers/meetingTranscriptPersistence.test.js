const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingTranscriptPersistence.ts");

const segment = (id, text) => ({ id, text, source: "system" });

function createIO({ persistedTranscript = null, getNoteError = null } = {}) {
  const calls = { getNote: [], updateNote: [], saveEmbeddings: [] };
  const io = {
    getNote: async (noteId) => {
      calls.getNote.push(noteId);
      if (getNoteError) throw getNoteError;
      return persistedTranscript == null
        ? { transcript: null }
        : { transcript: persistedTranscript };
    },
    updateNote: async (noteId, updates) => {
      calls.updateNote.push({ noteId, updates });
    },
    saveNoteSpeakerEmbeddings: async (noteId, embeddings) => {
      calls.saveEmbeddings.push({ noteId, embeddings });
    },
    parseSegments: (raw) => JSON.parse(raw),
    mergeSegments: (existing, incoming) => [...existing, ...incoming],
    serializeSegments: (segments) => JSON.stringify(segments),
  };
  return { io, calls };
}

test("buildFinalMeetingTranscript serializes segments when any exist", async () => {
  const { buildFinalMeetingTranscript } = await load();
  const segments = [segment("a", "hello")];

  assert.equal(
    buildFinalMeetingTranscript(segments, "fallback", (s) => JSON.stringify(s)),
    JSON.stringify(segments)
  );
});

test("buildFinalMeetingTranscript falls back to the plain transcript, then null", async () => {
  const { buildFinalMeetingTranscript } = await load();
  const serialize = () => {
    throw new Error("must not serialize an empty segment list");
  };

  assert.equal(buildFinalMeetingTranscript([], "plain text", serialize), "plain text");
  assert.equal(buildFinalMeetingTranscript([], "", serialize), null);
});

test("persistDiarizedMeetingTranscript merges into the persisted transcript", async () => {
  const { persistDiarizedMeetingTranscript } = await load();
  const persisted = [segment("p1", "persisted")];
  const { io, calls } = createIO({ persistedTranscript: JSON.stringify(persisted) });

  await persistDiarizedMeetingTranscript({
    noteId: 7,
    diarizedSegments: [segment("d1", "diarized")],
    speakerEmbeddings: { speaker_0: [0.1] },
    liveSegments: [segment("live", "must not be used")],
    io,
  });

  assert.deepEqual(calls.getNote, [7]);
  assert.deepEqual(calls.updateNote, [
    {
      noteId: 7,
      updates: { transcript: JSON.stringify([...persisted, segment("d1", "diarized")]) },
    },
  ]);
  assert.deepEqual(calls.saveEmbeddings, [{ noteId: 7, embeddings: { speaker_0: [0.1] } }]);
});

test("persistDiarizedMeetingTranscript falls back to live segments when the note is unreadable", async () => {
  const { persistDiarizedMeetingTranscript } = await load();
  const live = [segment("live", "live text")];
  const { io, calls } = createIO({ getNoteError: new Error("db closed") });

  await persistDiarizedMeetingTranscript({
    noteId: 3,
    diarizedSegments: [segment("d1", "diarized")],
    speakerEmbeddings: null,
    liveSegments: live,
    io,
  });

  assert.deepEqual(calls.updateNote, [
    { noteId: 3, updates: { transcript: JSON.stringify([...live, segment("d1", "diarized")]) } },
  ]);
  assert.deepEqual(calls.saveEmbeddings, []);
});

test("persistDiarizedMeetingTranscript uses live segments when the note has no transcript yet", async () => {
  const { persistDiarizedMeetingTranscript } = await load();
  const live = [segment("live", "live text")];
  const { io, calls } = createIO();

  await persistDiarizedMeetingTranscript({
    noteId: 3,
    diarizedSegments: [segment("d1", "diarized")],
    speakerEmbeddings: null,
    liveSegments: live,
    io,
  });

  assert.equal(calls.updateNote[0].updates.transcript.includes("live text"), true);
});

test("persistDiarizedMeetingTranscript assigns ids to diarized segments that lack one", async () => {
  const { persistDiarizedMeetingTranscript } = await load();
  const { io, calls } = createIO();

  await persistDiarizedMeetingTranscript({
    noteId: 3,
    diarizedSegments: [{ text: "no id", source: "system" }, segment("keep", "has id")],
    speakerEmbeddings: null,
    liveSegments: [],
    io,
  });

  const written = JSON.parse(calls.updateNote[0].updates.transcript);
  assert.deepEqual(
    written.map((s) => s.id),
    ["diarized-0", "keep"]
  );
});
