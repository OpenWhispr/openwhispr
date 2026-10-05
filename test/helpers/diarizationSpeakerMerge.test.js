const test = require("node:test");
const assert = require("node:assert/strict");

// mergeWithTranscript is pure, but diarization.js pulls in helpers that reach
// for electron at load time. Stub the pieces they touch so the merge rules can
// be exercised outside Electron.
require.cache[require.resolve("electron")] = {
  exports: {
    app: {
      getPath: () => "/tmp",
      getAppPath: () => process.cwd(),
      isPackaged: false,
    },
    net: {},
  },
};

const DiarizationManager = require("../../src/helpers/diarization.js");

const systemSegment = (timestamp, text) => ({ source: "system", timestamp, text });
const micSegment = (timestamp, text) => ({ source: "mic", timestamp, text });

test("a segment between clusters takes the nearest cluster, not the first", () => {
  const manager = new DiarizationManager();

  // Midpoint 51.25s: 46.25s past speaker_0, 8.75s before speaker_1.
  const merged = manager.mergeWithTranscript(
    [systemSegment(50, "so where did we land on pricing")],
    [
      { start: 0, end: 5, speaker: "speaker_0" },
      { start: 60, end: 70, speaker: "speaker_1" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("a segment past the last cluster belongs to that cluster", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [systemSegment(100, "one last thing before we wrap")],
    [
      { start: 0, end: 5, speaker: "speaker_0" },
      { start: 60, end: 70, speaker: "speaker_1" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("the largest overlapping cluster still wins over the nearest one", () => {
  const manager = new DiarizationManager();

  // The segment spans 50s–52.5s. speaker_0 overlaps 0.5s and starts exactly at
  // the segment, so it is both the first cluster and a zero-distance match;
  // speaker_1 overlaps 2s and must win on overlap.
  const merged = manager.mergeWithTranscript(
    [systemSegment(50, "that matches what I saw")],
    [
      { start: 50, end: 50.5, speaker: "speaker_0" },
      { start: 50.5, end: 53, speaker: "speaker_1" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("mic segments stay owned by you and survive an empty diarization run", () => {
  const manager = new DiarizationManager();

  const withClusters = manager.mergeWithTranscript(
    [{ source: "mic", timestamp: 1, text: "morning" }],
    [{ start: 0, end: 5, speaker: "speaker_0" }]
  );
  assert.equal(withClusters[0].speaker, "you");

  const withoutClusters = manager.mergeWithTranscript([systemSegment(1, "morning")], []);
  assert.equal(withoutClusters[0].speaker, undefined);
});

test("mic segments stay owned by you under an explicit system diarizedSource", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [micSegment(1, "morning")],
    [{ start: 0, end: 5, speaker: "speaker_0" }],
    { diarizedSource: "system" }
  );

  assert.equal(merged[0].speaker, "you");
});

test("mic mode assigns mic segments to clusters by overlap and nearest distance", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [
      micSegment(1, "so what did everyone think of the draft"),
      // Midpoint 51.25s: 46.25s past speaker_00, 8.75s before speaker_01.
      micSegment(50, "honestly the second section needs work"),
    ],
    [
      { start: 0, end: 5, speaker: "speaker_00" },
      { start: 60, end: 70, speaker: "speaker_01" },
    ],
    { diarizedSource: "mic" }
  );

  assert.equal(merged[0].speaker, "speaker_0");
  assert.equal(merged[1].speaker, "speaker_1");
});

test("mic mode with a single cluster keeps the mic track as you", () => {
  // A call where the remote party never speaks audibly diarizes the mic track;
  // its lone cluster is the user, not a stranger named speaker_0.
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [micSegment(1, "hello can you hear me"), micSegment(30, "okay I will follow up by email")],
    [{ start: 0, end: 40, speaker: "speaker_00" }],
    { diarizedSource: "mic" }
  );

  assert.equal(merged[0].speaker, "you");
  assert.equal(merged[1].speaker, "you");
});

test("mic mode leaves system segments unlabeled", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [systemSegment(1, "notification ding"), micSegment(2, "as I was saying")],
    [
      { start: 0, end: 5, speaker: "speaker_00" },
      { start: 10, end: 20, speaker: "speaker_01" },
    ],
    { diarizedSource: "mic" }
  );

  assert.equal(merged[0].speaker, undefined);
  assert.equal(merged[1].speaker, "speaker_0");
});

test("mic mode still dedupes bleed-flagged mic echoes of system text first", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [
      systemSegment(10, "the quarterly revenue forecast slipped again"),
      {
        ...micSegment(10.5, "the quarterly revenue forecast slipped again"),
        likelyRenderBleed: true,
      },
    ],
    [
      { start: 0, end: 5, speaker: "speaker_00" },
      { start: 10, end: 20, speaker: "speaker_01" },
    ],
    { diarizedSource: "mic" }
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "system");
});
