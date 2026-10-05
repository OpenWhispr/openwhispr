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
  isCollapsedDiarization,
  capSpeakerClustersByVoice,
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

// Too high a threshold is the opposite failure: at 0.72 and above, a
// 20-minute two-person call (#2021) came back as one speaker plus phantoms.
test("the long-audio threshold stays below where #2021's two speakers merged", () => {
  assert.ok(clusterThresholdForDuration(3 * 3600) < 0.72);
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

test("the second-largest cluster survives once its short segments pass the minimum", () => {
  const segments = [
    { start: 0, end: 30, speaker: "speaker_0" },
    { start: 30, end: 30.6, speaker: "speaker_1" },
    { start: 40, end: 40.6, speaker: "speaker_1" },
  ];
  assert.equal(dropNegligibleClusters(segments).length, 3);
});

// `count` segments of `seconds` each, so a fixture can reproduce a cluster's
// measured total speech and mean segment length.
function cluster(speaker, count, seconds) {
  return Array.from({ length: count }, (_, i) => ({
    start: i * 20,
    end: i * 20 + seconds,
    speaker,
  }));
}

const speakersOf = (segments) => [...new Set(segments.map((s) => s.speaker))].sort();

// Measured on a 20-minute two-person Spanish call (#2021): four phantom
// clusters of short backchannels and turn starts, each over the 1 s floor.
test("short-utterance phantom clusters are dropped from a two-person call", () => {
  const segments = [
    ...cluster("speaker_06", 79, 6.46),
    ...cluster("speaker_01", 85, 5.44),
    ...cluster("speaker_00", 23, 1.72),
    ...cluster("speaker_02", 20, 1.57),
    ...cluster("speaker_04", 9, 1.49),
    ...cluster("speaker_03", 2, 0.72),
  ];
  assert.deepEqual(speakersOf(dropNegligibleClusters(segments)), ["speaker_01", "speaker_06"]);
});

// The same call clustered at 0.65: the larger phantom held 5.6 % of the speech
// (59.6 s of 1058.4 s) in segments averaging 1.92 s.
test("a short-segment phantom under 10% of the speech is dropped", () => {
  const segments = [
    ...cluster("speaker_0", 94, 5.77),
    ...cluster("speaker_1", 83, 5.44),
    ...cluster("speaker_2", 31, 1.92),
    ...cluster("speaker_3", 3, 1.7),
  ];
  assert.deepEqual(speakersOf(dropNegligibleClusters(segments)), ["speaker_0", "speaker_1"]);
});

test("a minor third speaker with real turns survives", () => {
  const segments = [
    ...cluster("speaker_0", 80, 6),
    ...cluster("speaker_1", 80, 6),
    ...cluster("speaker_2", 7, 6),
    ...cluster("speaker_3", 20, 1.5),
  ];
  assert.deepEqual(speakersOf(dropNegligibleClusters(segments)), [
    "speaker_0",
    "speaker_1",
    "speaker_2",
  ]);
});

test("a short-turn speaker with a real share of the speech survives", () => {
  const segments = [
    ...cluster("speaker_0", 100, 2),
    ...cluster("speaker_1", 100, 2),
    ...cluster("speaker_2", 40, 2),
  ];
  assert.equal(speakersOf(dropNegligibleClusters(segments)).length, 3);
});

test("the second-largest cluster survives even when it looks like a phantom", () => {
  const segments = [
    ...cluster("speaker_0", 200, 6),
    ...cluster("speaker_1", 20, 1.5),
    ...cluster("speaker_2", 10, 1.5),
  ];
  assert.deepEqual(speakersOf(dropNegligibleClusters(segments)), ["speaker_0", "speaker_1"]);
});

// Forcing two clusters on #2021's call put both real speakers in one cluster
// and kept a phantom for the rest.
test("one cluster holding nearly all the speech is a collapsed run", () => {
  const segments = [...cluster("speaker_01", 165, 6.06), ...cluster("speaker_00", 35, 1.72)];
  assert.equal(isCollapsedDiarization(segments), true);
});

test("a balanced run or a single cluster is not a collapsed run", () => {
  const balanced = [...cluster("speaker_06", 79, 6.46), ...cluster("speaker_01", 85, 5.44)];
  assert.equal(isCollapsedDiarization(balanced), false);
  assert.equal(isCollapsedDiarization(cluster("speaker_0", 50, 6)), false);
  assert.equal(isCollapsedDiarization([]), false);
});

test("a dominant speaker beside someone with real turns is not a collapsed run", () => {
  const lecture = [...cluster("speaker_0", 550, 6), ...cluster("speaker_1", 5, 6)];
  assert.equal(isCollapsedDiarization(lecture), false);
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

// sherpa numbers clusters by first appearance, and on #2021's call the first
// cluster (speaker_00) was a phantom. Protection must follow size, not order.
test("the protected clusters are the largest, whatever order sherpa lists them in", () => {
  const segments = [
    ...cluster("speaker_00", 23, 1.72),
    ...cluster("speaker_01", 85, 5.44),
    ...cluster("speaker_02", 20, 1.57),
    ...cluster("speaker_06", 79, 6.46),
  ];
  assert.deepEqual(speakersOf(dropNegligibleClusters(segments)), ["speaker_01", "speaker_06"]);
});

test("the 1 s floor applies to the protected second-largest cluster", () => {
  const segments = [...cluster("speaker_0", 5, 6), ...cluster("speaker_1", 2, 0.4)];
  assert.deepEqual(speakersOf(dropNegligibleClusters(segments)), ["speaker_0"]);
});

test("a short-segment cluster at exactly 10% of the speech is kept", () => {
  const segments = [
    ...cluster("speaker_0", 45, 10),
    ...cluster("speaker_1", 45, 10),
    ...cluster("speaker_2", 50, 2),
  ];
  assert.equal(speakersOf(dropNegligibleClusters(segments)).length, 3);
});

test("a small cluster is kept from a 3 s mean segment up and dropped below it", () => {
  const withMean = (seconds, count) => [
    ...cluster("speaker_0", 47, 10),
    ...cluster("speaker_1", 47, 10),
    ...cluster("speaker_2", count, seconds),
  ];
  assert.equal(speakersOf(dropNegligibleClusters(withMean(3, 20))).length, 3);
  assert.equal(speakersOf(dropNegligibleClusters(withMean(4, 15))).length, 3);
  assert.equal(speakersOf(dropNegligibleClusters(withMean(2.5, 20))).length, 2);
});

// Documented cost of the phantom rule: by duration alone, a real third
// participant with under 10 % of the speech in short turns looks like a
// phantom. Flip this deliberately if the rule learns to use voices.
test("characterization: a quiet third participant in short turns is dropped", () => {
  const segments = [
    ...cluster("speaker_0", 60, 7.5),
    ...cluster("speaker_1", 60, 7.5),
    ...cluster("speaker_2", 34, 2.8),
  ];
  assert.deepEqual(speakersOf(dropNegligibleClusters(segments)), ["speaker_0", "speaker_1"]);
});

test("a collapsed run is found whatever order sherpa lists its clusters in", () => {
  const segments = [...cluster("speaker_00", 35, 1.72), ...cluster("speaker_01", 165, 6.06)];
  assert.equal(isCollapsedDiarization(segments), true);
});

test("a run is collapsed only above 93% for the largest cluster", () => {
  const withTop = (seconds) => [
    ...cluster("speaker_0", 1, seconds),
    ...cluster("speaker_1", 35, 2),
  ];
  assert.equal(isCollapsedDiarization(withTop(930)), false);
  assert.equal(isCollapsedDiarization(withTop(931)), true);
});

// Short turns alone don't make a collapse: someone holding 15 % of the speech
// in quick replies is a real second speaker.
test("a lopsided conversation in short turns on both sides is not collapsed", () => {
  const segments = [...cluster("speaker_0", 425, 2), ...cluster("speaker_1", 75, 2)];
  assert.equal(isCollapsedDiarization(segments), false);
});

test("a run is not collapsed while any other cluster averages 2.2 s segments or more", () => {
  const beside = (seconds) => [
    ...cluster("speaker_0", 100, 10),
    ...cluster("speaker_1", 1, seconds),
  ];
  assert.equal(isCollapsedDiarization(beside(2.2)), false);
  assert.equal(isCollapsedDiarization(beside(2.19)), true);

  const oneRealBesidePhantom = [
    ...cluster("speaker_0", 91, 10),
    ...cluster("speaker_1", 10, 5),
    ...cluster("speaker_2", 20, 2),
  ];
  assert.equal(isCollapsedDiarization(oneRealBesidePhantom), false);
});

// The 1 s floor exists for these blips; a monologue must keep its label.
test("a single speaker beside a sub-second blip is not collapsed", () => {
  const monologue = [...cluster("speaker_0", 100, 6), ...cluster("speaker_1", 1, 0.45)];
  assert.equal(isCollapsedDiarization(monologue), false);

  const blips = [
    ...cluster("speaker_0", 100, 6),
    ...cluster("speaker_1", 1, 0.5),
    ...cluster("speaker_2", 2, 0.4),
  ];
  assert.equal(isCollapsedDiarization(blips), false);
});

test("interviews, podcasts and lectures dominated by one voice keep their labels", () => {
  const oralHistory = [...cluster("speaker_0", 40, 60), ...cluster("speaker_1", 40, 2.5)];
  const podcast = [...cluster("speaker_0", 60, 20), ...cluster("speaker_1", 40, 2.9)];
  const lecture = [...cluster("speaker_0", 500, 6), ...cluster("speaker_1", 6, 2.8)];
  for (const run of [oralHistory, podcast, lecture]) {
    assert.equal(isCollapsedDiarization(run), false);
  }
});

test("characterization: a listener who only backchannels beside a dominant speaker reads as collapsed", () => {
  const segments = [...cluster("speaker_0", 100, 10), ...cluster("speaker_1", 30, 1.8)];
  assert.equal(isCollapsedDiarization(segments), true);
});

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

test("an extra cluster is relabelled to the kept speaker it sounds like", () => {
  const segments = [
    ...cluster("speaker_0", 10, 10),
    ...cluster("speaker_1", 8, 10),
    ...cluster("speaker_2", 6, 10),
  ];
  const centroids = new Map([
    ["speaker_0", [1, 0]],
    ["speaker_1", [0, 1]],
    ["speaker_2", [0.1, 0.9]],
  ]);
  const capped = capSpeakerClustersByVoice(segments, 2, centroids, dot);
  assert.deepEqual(speakersOf(capped), ["speaker_0", "speaker_1"]);
  assert.equal(capped.filter((s) => s.speaker === "speaker_1").length, 14);
  assert.deepEqual(
    capped.slice(0, 18).map((s) => s.speaker),
    segments.slice(0, 18).map((s) => s.speaker)
  );
});

test("an extra cluster without a usable voice folds into the largest", () => {
  const segments = [
    ...cluster("speaker_0", 10, 10),
    ...cluster("speaker_1", 8, 10),
    ...cluster("speaker_2", 6, 10),
  ];
  const noExtraVoice = new Map([
    ["speaker_0", [1, 0]],
    ["speaker_1", [0, 1]],
  ]);
  const capped = capSpeakerClustersByVoice(segments, 2, noExtraVoice, dot);
  assert.equal(capped.filter((s) => s.speaker === "speaker_0").length, 16);

  // A kept speaker without a voice can't be matched, so the extra goes to the
  // closest kept speaker that has one.
  const onlySecondVoice = new Map([
    ["speaker_1", [0, 1]],
    ["speaker_2", [1, 0]],
  ]);
  const matched = capSpeakerClustersByVoice(segments, 2, onlySecondVoice, dot);
  assert.equal(matched.filter((s) => s.speaker === "speaker_1").length, 14);
});

test("the voice cap leaves a run within the cap untouched and can fold everything into one", () => {
  const segments = [...cluster("speaker_0", 10, 10), ...cluster("speaker_1", 8, 10)];
  assert.equal(capSpeakerClustersByVoice(segments, 2, new Map(), dot), segments);
  assert.deepEqual(speakersOf(capSpeakerClustersByVoice(segments, 1, new Map(), dot)), [
    "speaker_0",
  ]);
});
