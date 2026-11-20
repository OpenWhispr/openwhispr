const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDiarizationTarget,
  selectBaseSegments,
  withoutRemovedSegments,
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

test("late note finals stay in capture order within the recording that produced them", async () => {
  const { mergeSessionDiarization } = await import("../../src/utils/diarizationCompletion.ts");
  const row = (text, source, timestamp) => ({ id: text, text, source, timestamp });
  const previous = row("previous recording", "mic", 50);
  const remote = row("system audio", "system", 2);
  const earlier = row("microphone", "mic", 1);
  const tail = row("last words", "mic", 3);
  const resumed = row("next recording", "mic", 0);

  for (const existing of [[previous], [previous, remote, resumed]]) {
    const { segments, removedCount } = mergeSessionDiarization({
      existing,
      seedLength: 1,
      segments: [remote, tail, earlier],
    });
    const expected = [previous, earlier, remote, tail];
    if (existing.includes(resumed)) expected.push(resumed);
    assert.deepEqual(
      segments.map((s) => s.text),
      expected.map((s) => s.text)
    );
    assert.equal(removedCount, existing.length - segments.length);
  }
});

test("late finals never land among a later recording's rows or move its start wrongly", async () => {
  const { mergeSessionDiarization } = await import("../../src/utils/diarizationCompletion.ts");
  // Saved rows carry stored ids and main's rows carry none, so they pair by text.
  const saved = (text, index) => ({ id: `stored-${index}`, text, source: "mic", timestamp: index });
  const fromMain = (text, timestamp) => ({ text, source: "mic", timestamp });
  const texts = (segments) => segments.map((segment) => segment.text);

  // The first recording's only saved row was an echo main dropped, so nothing pairs.
  const echoOnly = ["seed", "echo", "hello again", "second"].map(saved);
  const unmatched = mergeSessionDiarization({
    existing: echoOnly,
    seedLength: 1,
    sessionEnd: 2,
    segments: [fromMain("late one", 5), fromMain("late two", 6)],
    removedSegments: [{ text: "echo", source: "mic", timestamp: 1 }],
  });
  assert.deepEqual(texts(unmatched.segments), [
    "seed",
    "late one",
    "late two",
    "hello again",
    "second",
  ]);
  assert.equal(2 - unmatched.removedCount, texts(unmatched.segments).indexOf("hello again"));

  // A stock phrase said in both recordings pairs only with the first one's row.
  const repeated = ["seed", "saved", "hello again", "Okay.", "second"].map(saved);
  const collided = mergeSessionDiarization({
    existing: repeated,
    seedLength: 1,
    sessionEnd: 2,
    segments: [fromMain("saved", 1), fromMain("late one", 2), fromMain("Okay.", 3)],
  });
  assert.deepEqual(texts(collided.segments), [
    "seed",
    "saved",
    "late one",
    "Okay.",
    "hello again",
    "Okay.",
    "second",
  ]);
  assert.equal(collided.segments[5].id, "stored-3");
  assert.equal(2 - collided.removedCount, texts(collided.segments).indexOf("hello again"));
});

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

// #2781: rows main dropped must leave the persisted transcript, or the merge
// keeps them with their raw epoch-ms timestamps.
test("withoutRemovedSegments drops exact source/timestamp/text matches only", () => {
  const segments = [
    { id: "a", source: "mic", text: "hello", timestamp: 1792414001000 },
    { id: "b", source: "system", text: "hello", timestamp: 1792414001000 },
    { id: "c", source: "mic", text: "hello", timestamp: 1792414002000 },
  ];
  const result = withoutRemovedSegments(segments, [
    { source: "mic", text: "hello", timestamp: 1792414001000 },
  ]);
  assert.deepEqual(
    result.map((segment) => segment.id),
    ["b", "c"]
  );
});

test("withoutRemovedSegments removes one row per removed entry", () => {
  const row = { source: "mic", text: "yes", timestamp: 1792414003000 };
  const segments = [
    { id: "a", ...row },
    { id: "b", ...row },
  ];
  const result = withoutRemovedSegments(segments, [row]);
  assert.deepEqual(
    result.map((segment) => segment.id),
    ["b"]
  );
});

test("withoutRemovedSegments returns the input when nothing was removed", () => {
  const segments = [{ id: "a", source: "mic", text: "hi", timestamp: 1 }];
  assert.deepEqual(withoutRemovedSegments(segments, undefined), segments);
  assert.deepEqual(withoutRemovedSegments(segments, []), segments);
});

test("diarization preserves the recorder while still numbering in-person voices", async () => {
  const { mergeSessionDiarization } = await import("../../src/utils/diarizationCompletion.ts");
  const { buildLlmTranscript } = await import("../../src/utils/llmTranscript.ts");
  const existing = [
    { id: "bob", source: "mic", text: "hello", timestamp: 1, recorderName: "Bob Viewer" },
  ];
  const merged = mergeSessionDiarization({
    existing,
    seedLength: 0,
    segments: [{ source: "mic", text: "hello", timestamp: 1, speaker: "you" }],
  }).segments;
  assert.equal(merged[0].recorderName, "Bob Viewer");
  assert.equal(
    buildLlmTranscript(merged, {}, "Alice", (key) => key),
    "Bob Viewer: hello"
  );
  const numbered = mergeSessionDiarization({
    existing,
    seedLength: 0,
    segments: [{ source: "mic", text: "hello", timestamp: 1, speaker: "speaker_0" }],
  }).segments;
  assert.equal(
    buildLlmTranscript(numbered, {}, "Alice", (_key, opts) => `Speaker ${opts.n}`),
    "Speaker 1: hello"
  );
});

// With no speaker count, every remote line is the one live speaker, and naming
// it locks that name onto all of them. Diarization then finds several voices.
async function mergeIntoLockedRows(lockedName, splitLiveSpeakers) {
  const { mergeSessionDiarization } = await import("../../src/utils/diarizationCompletion.ts");
  const { lockTranscriptSpeaker } = await import("../../src/utils/transcriptSpeakerState.ts");
  const row = (id, timestamp, speaker, speakerName) => ({
    id,
    source: "system",
    text: id,
    timestamp,
    speaker,
    speakerName,
  });
  const existing = ["a", "b", "c"].map((id, i) =>
    lockTranscriptSpeaker(row(id, i, "speaker_0"), { speakerName: lockedName })
  );
  const segments = [
    row("a", 0, "speaker_1", "Alice"),
    row("b", 1, "speaker_0", null),
    row("c", 2, "speaker_2", "Bob"),
  ].map((segment) => ({ ...segment, speakerStatus: "confirmed" }));

  return mergeSessionDiarization({
    existing,
    seedLength: 0,
    segments,
    splitLiveSpeakers,
  }).segments.map((segment) => [segment.speaker, segment.speakerName, segment.speakerLocked]);
}

test("a name locked onto a live speaker stays only with the voice it went to", async () => {
  const merged = await mergeIntoLockedRows("Alice", {
    speaker_0: { speaker: "speaker_1", name: "Alice" },
  });

  assert.deepEqual(merged, [
    ["speaker_1", "Alice", true],
    ["speaker_0", null, false],
    ["speaker_2", "Bob", false],
  ]);
});

test("a locked name that matched no voice stays on every line it was given to", async () => {
  const merged = await mergeIntoLockedRows("Alice", undefined);

  assert.deepEqual(merged, [
    ["speaker_1", "Alice", true],
    ["speaker_0", "Alice", true],
    ["speaker_2", "Alice", true],
  ]);
});

test("lines the user gave another name keep it when their live speaker is split", async () => {
  const merged = await mergeIntoLockedRows("Carol", {
    speaker_0: { speaker: "speaker_1", name: "Alice" },
  });

  assert.deepEqual(
    merged.map(([, name, locked]) => [name, locked]),
    [
      ["Carol", true],
      ["Carol", true],
      ["Carol", true],
    ]
  );
});
