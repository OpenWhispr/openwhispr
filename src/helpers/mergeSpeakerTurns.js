// Collapses raw diarization segments (which can be many short VAD-driven slices
// per speaker) into coherent speaker turns, so a single-channel transcription
// makes one transcribe call per turn instead of one per tiny diarization segment.
function mergeSpeakerTurns(segments, options = {}) {
  const { maxGapSec = 1.5, maxTurnSec = 60 } = options;
  if (!segments || segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const turns = [];
  let current = null;

  for (const seg of sorted) {
    if (
      current &&
      current.speaker === seg.speaker &&
      seg.start - current.end <= maxGapSec &&
      seg.end - current.start <= maxTurnSec
    ) {
      current.end = Math.max(current.end, seg.end);
    } else {
      if (current) turns.push(current);
      current = { speaker: seg.speaker, start: seg.start, end: seg.end };
    }
  }
  if (current) turns.push(current);

  return turns;
}

// Maps raw diarization speaker ids (e.g. "speaker_00") to friendly sequential
// labels ("Speaker 1", "Speaker 2", ...) in order of first appearance.
function buildSpeakerLabels(turns, labelPrefix = "Speaker") {
  const labels = new Map();
  let idx = 1;
  for (const turn of turns) {
    if (!labels.has(turn.speaker)) {
      labels.set(turn.speaker, `${labelPrefix} ${idx}`);
      idx++;
    }
  }
  return labels;
}

module.exports = { mergeSpeakerTurns, buildSpeakerLabels };
