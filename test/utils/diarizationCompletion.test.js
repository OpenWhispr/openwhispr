const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDiarizationTarget,
  selectBaseSegments,
} = require("../../src/utils/diarizationCompletion.ts");

// Issue #1495: a delayed diarization result must be saved to the note that
// owns the recording session, never to whichever note happens to be rendered.
// Persistence runs at store level; `isCurrentSession` gates only whether the
// result is published to the UI.

test("payload noteId targets the owning note", () => {
  const result = resolveDiarizationTarget({
    payloadNoteId: 1,
    payloadSessionId: "diar-100",
    currentSessionId: "diar-100",
  });
  assert.deepEqual(result, { targetNoteId: 1, isCurrentSession: true });
});

test("payload noteId still targets the owning note after a new session started", () => {
  // Data-loss mode of #1495: Meeting B already started, so the store's
  // session no longer matches A's — A's result must still land on A, but
  // must not be published to a UI that is waiting on the newer session.
  const result = resolveDiarizationTarget({
    payloadNoteId: 1,
    payloadSessionId: "diar-100",
    currentSessionId: "diar-200",
  });
  assert.deepEqual(result, { targetNoteId: 1, isCurrentSession: false });
});

test("payload noteId with no pending session is current", () => {
  // Nothing newer is pending, so publishing is safe and clearing a waiting
  // spinner prevents it from getting stuck.
  const result = resolveDiarizationTarget({
    payloadNoteId: 1,
    payloadSessionId: "diar-100",
    currentSessionId: null,
  });
  assert.deepEqual(result, { targetNoteId: 1, isCurrentSession: true });
});

// A restarted recording resets diarizationSessionId to null, so "no pending
// session" stops meaning "nothing newer is happening". Publishing the finished
// half's snapshot then paints it over the live recording — and the editor
// prefers that overlay, so the note looks truncated and one speaker rename
// writes the truncated copy to disk.
test("a live recording on the target note supersedes a result with no pending session", () => {
  const result = resolveDiarizationTarget({
    payloadNoteId: 1,
    payloadSessionId: "diar-100",
    currentSessionId: null,
    activeRecordingNoteId: 1,
  });
  assert.deepEqual(result, { targetNoteId: 1, isCurrentSession: false });
});

test("a live recording on another note does not supersede the result", () => {
  const result = resolveDiarizationTarget({
    payloadNoteId: 1,
    payloadSessionId: "diar-100",
    currentSessionId: null,
    activeRecordingNoteId: 2,
  });
  assert.deepEqual(result, { targetNoteId: 1, isCurrentSession: true });
});

// recordingNoteId outlives the recording that set it, so the caller passes null
// once the recording stops — otherwise the note could never publish again.
test("a stopped recording no longer supersedes its own note's result", () => {
  const result = resolveDiarizationTarget({
    payloadNoteId: 1,
    payloadSessionId: "diar-100",
    currentSessionId: null,
    activeRecordingNoteId: null,
  });
  assert.deepEqual(result, { targetNoteId: 1, isCurrentSession: true });
});

test("a payload without a noteId is dropped", () => {
  // Main snapshots the same noteId the renderer passed to
  // meetingTranscriptionStart, so a missing one means the recording was never
  // tied to a note and there is nothing to persist to.
  const result = resolveDiarizationTarget({
    payloadNoteId: null,
    payloadSessionId: "diar-100",
    currentSessionId: "diar-100",
  });
  assert.deepEqual(result, { targetNoteId: null, isCurrentSession: true });
});

const seg = (id) => ({ id, text: id, source: "mic" });

test("persisted segments of the target note win over live segments", () => {
  const persisted = [seg("p1")];
  const result = selectBaseSegments({
    persistedSegments: persisted,
    liveSegments: [seg("l1")],
    recordingNoteId: 1,
    targetNoteId: 1,
  });
  assert.equal(result, persisted);
});

test("an empty persisted transcript still wins over the fallbacks", () => {
  // A transcript that parses to zero segments is authoritative for the note;
  // falling back to live segments would reintroduce stale data.
  const persisted = [];
  const result = selectBaseSegments({
    persistedSegments: persisted,
    liveSegments: [seg("l1")],
    recordingNoteId: 1,
    targetNoteId: 1,
  });
  assert.equal(result, persisted);
});

test("live segments are used only when the recording belongs to the target note", () => {
  const live = [seg("l1")];
  const result = selectBaseSegments({
    persistedSegments: null,
    liveSegments: live,
    recordingNoteId: 1,
    targetNoteId: 1,
  });
  assert.equal(result, live);
});

test("another note's live segments are never merged into the target note", () => {
  // The cross-contamination guard: the store's live segments belong to the
  // recording note — they must not become part of any other note's transcript.
  const result = selectBaseSegments({
    persistedSegments: null,
    liveSegments: [seg("l1")],
    recordingNoteId: 2,
    targetNoteId: 1,
  });
  assert.deepEqual(result, []);
});

test("no persisted transcript and empty live segments merge into nothing", () => {
  const result = selectBaseSegments({
    persistedSegments: null,
    liveSegments: [],
    recordingNoteId: 1,
    targetNoteId: 1,
  });
  assert.deepEqual(result, []);
});
