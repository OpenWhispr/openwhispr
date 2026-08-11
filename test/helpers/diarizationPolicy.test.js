const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_CLUSTER_THRESHOLD,
  LONG_AUDIO_CLUSTER_THRESHOLD,
  THRESHOLD_RAMP_START_SECONDS,
  THRESHOLD_RAMP_END_SECONDS,
  MIN_CLUSTER_TOTAL_SECONDS,
  clusterThresholdForDuration,
  resolveClusterThreshold,
  dropNegligibleClusters,
} = require("../../src/helpers/diarizationPolicy");

// 0.55 is tuned for short clean audio; on a 73-minute single-mic voice memo one
// speaker's embeddings spread past it and clustering stopped merging at 46
// "speakers". The threshold must grow with duration.
test("short audio keeps the sherpa default threshold", () => {
  assert.equal(clusterThresholdForDuration(0), DEFAULT_CLUSTER_THRESHOLD);
  assert.equal(
    clusterThresholdForDuration(THRESHOLD_RAMP_START_SECONDS),
    DEFAULT_CLUSTER_THRESHOLD
  );
});

test("threshold ramps between the boundaries and is monotonic", () => {
  const mid = clusterThresholdForDuration(
    (THRESHOLD_RAMP_START_SECONDS + THRESHOLD_RAMP_END_SECONDS) / 2
  );
  assert.ok(mid > DEFAULT_CLUSTER_THRESHOLD && mid < LONG_AUDIO_CLUSTER_THRESHOLD);
  assert.ok(
    clusterThresholdForDuration(THRESHOLD_RAMP_START_SECONDS + 60) <= mid,
    "threshold must not decrease with duration"
  );
});

test("hour-plus audio is clamped to the long-audio threshold", () => {
  assert.equal(
    clusterThresholdForDuration(THRESHOLD_RAMP_END_SECONDS),
    LONG_AUDIO_CLUSTER_THRESHOLD
  );
  assert.equal(clusterThresholdForDuration(3 * 3600), LONG_AUDIO_CLUSTER_THRESHOLD);
});

test("unknown duration falls back to the default threshold", () => {
  assert.equal(clusterThresholdForDuration(NaN), DEFAULT_CLUSTER_THRESHOLD);
  assert.equal(clusterThresholdForDuration(undefined), DEFAULT_CLUSTER_THRESHOLD);
  assert.equal(clusterThresholdForDuration(-5), DEFAULT_CLUSTER_THRESHOLD);
});

test("explicit thresholds accept zero, clamp bounds, and reject non-finite values", () => {
  assert.equal(resolveClusterThreshold(3600, 0), 0);
  assert.equal(resolveClusterThreshold(3600, 2), 1);
  assert.equal(resolveClusterThreshold(3600, -1), 0);
  assert.equal(resolveClusterThreshold(3600, ""), clusterThresholdForDuration(3600));
  assert.equal(resolveClusterThreshold(3600, "not-a-number"), clusterThresholdForDuration(3600));
  assert.equal(resolveClusterThreshold(3600, Infinity), clusterThresholdForDuration(3600));
});

// Every cluster — however tiny — wins at least one sentence in the character-
// proportional merge, so a stray blip becomes a phantom [Speaker N].
test("clusters below the minimum total speaking time are dropped", () => {
  const segments = [
    { start: 0, end: 30, speaker: "speaker_0" },
    { start: 30, end: 30.4, speaker: "speaker_7" },
    { start: 31, end: 60, speaker: "speaker_1" },
    { start: 60, end: 60.3, speaker: "speaker_7" },
  ];
  const kept = dropNegligibleClusters(segments);
  assert.deepEqual(
    kept.map((s) => s.speaker),
    ["speaker_0", "speaker_1"]
  );
});

test("a cluster whose short segments add up past the minimum survives", () => {
  const segments = [
    { start: 0, end: 30, speaker: "speaker_0" },
    { start: 30, end: 30.6, speaker: "speaker_1" },
    { start: 40, end: 40.6, speaker: "speaker_1" },
  ];
  assert.equal(dropNegligibleClusters(segments).length, 3);
});

test("dropping never empties the result or touches a clean input", () => {
  const allTiny = [
    { start: 0, end: 0.3, speaker: "speaker_0" },
    { start: 1, end: 1.2, speaker: "speaker_1" },
  ];
  assert.deepEqual(dropNegligibleClusters(allTiny), allTiny);

  const clean = [{ start: 0, end: 10, speaker: "speaker_0" }];
  assert.deepEqual(dropNegligibleClusters(clean), clean);
  assert.deepEqual(dropNegligibleClusters([]), []);
  assert.equal(dropNegligibleClusters(null), null);
});

test("minimum speaking time constant is sane", () => {
  assert.ok(MIN_CLUSTER_TOTAL_SECONDS >= 0.5 && MIN_CLUSTER_TOTAL_SECONDS <= 5);
});
