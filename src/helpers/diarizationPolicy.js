// Clustering policy for the upload/batch diarization path. Kept free of
// electron imports so the rules stay unit-testable (pattern: cloudChunkPolicy).

// sherpa-onnx's cluster threshold is a cosine distance: higher merges more.
// 0.55 suits short clean audio, but over a long single-mic recording one
// speaker's embeddings drift wider than that and agglomerative clustering
// stops merging early — a 73-minute voice memo produced 46 "speakers". Ramp
// the threshold with duration instead of pretending one constant fits both.
// The top stays below 0.72: from there up, a two-person Spanish call merged
// both speakers into one cluster.
const DEFAULT_CLUSTER_THRESHOLD = 0.55;
const LONG_AUDIO_CLUSTER_THRESHOLD = 0.7;
const THRESHOLD_RAMP_START_SECONDS = 15 * 60;
const THRESHOLD_RAMP_END_SECONDS = 60 * 60;

// A cluster with under a second of total speech is embedding noise, not a
// person — and the character-proportional merge hands every surviving cluster
// at least one sentence, so each blip becomes a phantom [Speaker N].
const MIN_CLUSTER_TOTAL_SECONDS = 1;

// Longer recordings grow phantoms well past that floor: backchannels and turn
// starts whose 1–3 s embeddings land near neither speaker's centroid (a
// 20-minute two-person call produced four, holding 8 % of the speech). A
// phantom is both a sliver of the speech and made of short segments; a real
// minor speaker holds longer turns.
const PHANTOM_MAX_SHARE = 0.1;
const PHANTOM_MAX_MEAN_SEGMENT_SECONDS = 3;
// Merging two real speakers is the worse failure, so the two largest clusters
// are never treated as phantoms.
const PROTECTED_CLUSTER_COUNT = 2;

// When clustering merges two real speakers, one cluster ends up with nearly
// all the speech and only short-utterance phantoms beside it (94–96 % on
// #2021's call). A dominant speaker beside someone with real turns is a
// lecture or an interview, not a collapse.
const COLLAPSED_TOP_SHARE = 0.9;

function clusterThresholdForDuration(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= THRESHOLD_RAMP_START_SECONDS) {
    return DEFAULT_CLUSTER_THRESHOLD;
  }
  if (durationSeconds >= THRESHOLD_RAMP_END_SECONDS) return LONG_AUDIO_CLUSTER_THRESHOLD;
  const progress =
    (durationSeconds - THRESHOLD_RAMP_START_SECONDS) /
    (THRESHOLD_RAMP_END_SECONDS - THRESHOLD_RAMP_START_SECONDS);
  return (
    DEFAULT_CLUSTER_THRESHOLD +
    (LONG_AUDIO_CLUSTER_THRESHOLD - DEFAULT_CLUSTER_THRESHOLD) * progress
  );
}

function resolveClusterThreshold(durationSeconds, requestedThreshold) {
  const automaticThreshold = clusterThresholdForDuration(durationSeconds);
  if (requestedThreshold == null || requestedThreshold === "") return automaticThreshold;
  const parsedThreshold = Number(requestedThreshold);
  if (!Number.isFinite(parsedThreshold)) return automaticThreshold;
  return Math.min(1, Math.max(0, parsedThreshold));
}

function summarizeClusters(segments) {
  const clusters = new Map();
  let totalSpeech = 0;
  for (const s of segments) {
    const cluster = clusters.get(s.speaker) || { total: 0, count: 0 };
    cluster.total += s.end - s.start;
    cluster.count += 1;
    clusters.set(s.speaker, cluster);
    totalSpeech += s.end - s.start;
  }
  return { clusters, totalSpeech };
}

function dropNegligibleClusters(segments) {
  if (!segments?.length) return segments;
  const { clusters, totalSpeech } = summarizeClusters(segments);
  const keep = new Set(
    [...clusters]
      .sort((a, b) => b[1].total - a[1].total)
      .filter(([, { total, count }], rank) => {
        if (total < MIN_CLUSTER_TOTAL_SECONDS) return false;
        return (
          rank < PROTECTED_CLUSTER_COUNT ||
          total / totalSpeech >= PHANTOM_MAX_SHARE ||
          total / count >= PHANTOM_MAX_MEAN_SEGMENT_SECONDS
        );
      })
      .map(([speaker]) => speaker)
  );
  if (keep.size === 0 || keep.size === clusters.size) return segments;
  return segments.filter((s) => keep.has(s.speaker));
}

function isCollapsedDiarization(segments) {
  const { clusters, totalSpeech } = summarizeClusters(segments);
  if (clusters.size < 2) return false;
  const [largest, ...rest] = [...clusters.values()].sort((a, b) => b.total - a.total);
  return (
    largest.total / totalSpeech > COLLAPSED_TOP_SHARE &&
    rest.every(({ total, count }) => total / count < PHANTOM_MAX_MEAN_SEGMENT_SECONDS)
  );
}

module.exports = {
  DEFAULT_CLUSTER_THRESHOLD,
  LONG_AUDIO_CLUSTER_THRESHOLD,
  THRESHOLD_RAMP_START_SECONDS,
  THRESHOLD_RAMP_END_SECONDS,
  MIN_CLUSTER_TOTAL_SECONDS,
  clusterThresholdForDuration,
  resolveClusterThreshold,
  dropNegligibleClusters,
  isCollapsedDiarization,
};
