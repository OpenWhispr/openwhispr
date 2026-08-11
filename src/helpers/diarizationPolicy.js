// Clustering policy for the upload/batch diarization path. Kept free of
// electron imports so the rules stay unit-testable (pattern: cloudChunkPolicy).

// sherpa-onnx's cluster threshold is a cosine distance: higher merges more.
// 0.55 suits short clean audio, but over a long single-mic recording one
// speaker's embeddings drift wider than that and agglomerative clustering
// stops merging early — a 73-minute voice memo produced 46 "speakers". Ramp
// the threshold with duration instead of pretending one constant fits both.
const DEFAULT_CLUSTER_THRESHOLD = 0.55;
const LONG_AUDIO_CLUSTER_THRESHOLD = 0.8;
const THRESHOLD_RAMP_START_SECONDS = 15 * 60;
const THRESHOLD_RAMP_END_SECONDS = 60 * 60;

// A cluster with under a second of total speech is embedding noise, not a
// person — and the character-proportional merge hands every surviving cluster
// at least one sentence, so each blip becomes a phantom [Speaker N].
const MIN_CLUSTER_TOTAL_SECONDS = 1;

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

function dropNegligibleClusters(segments, minTotalSeconds = MIN_CLUSTER_TOTAL_SECONDS) {
  if (!segments?.length) return segments;
  const totals = new Map();
  for (const s of segments) {
    totals.set(s.speaker, (totals.get(s.speaker) || 0) + (s.end - s.start));
  }
  const keep = new Set(
    [...totals].filter(([, total]) => total >= minTotalSeconds).map(([speaker]) => speaker)
  );
  if (keep.size === 0 || keep.size === totals.size) return segments;
  return segments.filter((s) => keep.has(s.speaker));
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
};
