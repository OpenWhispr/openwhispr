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
