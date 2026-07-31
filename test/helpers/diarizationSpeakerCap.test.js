const test = require("node:test");
const assert = require("node:assert/strict");

const DiarizationManager = require("../../src/helpers/diarization");

const manager = new DiarizationManager();

// Unit vectors: a/b sound alike, c is clearly a different voice.
const voiceA = [1, 0, 0];
const voiceB = [0.95, 0.31, 0];
const voiceC = [0, 0, 1];

const segments = [
  { start: 0, end: 30, speaker: "speaker_00" },
  { start: 30, end: 40, speaker: "speaker_01" },
  { start: 40, end: 45, speaker: "speaker_02" },
];

test("an over-cap cluster folds into the speaker it sounds like", () => {
  const capped = manager.capSpeakerClusters(segments, 2, {
    speaker_00: voiceA,
    speaker_01: voiceC,
    speaker_02: voiceB,
  });

  assert.deepEqual(
    capped.map((s) => s.speaker),
    ["speaker_00", "speaker_01", "speaker_00"]
  );
});

test("an over-cap cluster that matches nobody keeps its own speaker", () => {
  const capped = manager.capSpeakerClusters(segments, 2, {
    speaker_00: voiceA,
    speaker_01: voiceB,
    speaker_02: voiceC,
  });

  assert.deepEqual(
    capped.map((s) => s.speaker),
    ["speaker_00", "speaker_01", "speaker_02"]
  );
});

test("clusters are never collapsed into the most talkative speaker blindly", () => {
  const capped = manager.capSpeakerClusters(segments, 1, null);

  assert.deepEqual(
    capped.map((s) => s.speaker),
    ["speaker_00", "speaker_01", "speaker_02"]
  );
});

test("a cluster count within the cap is left untouched", () => {
  assert.equal(manager.capSpeakerClusters(segments, 3), segments);
  assert.equal(manager.capSpeakerClusters(segments, 0), segments);
});
