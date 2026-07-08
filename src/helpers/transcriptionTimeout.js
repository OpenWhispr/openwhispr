// Floor keeps short dictations on the same 5-minute budget as before.
const TRANSCRIPTION_TIMEOUT_FLOOR_MS = 300000;
// 10x real-time budget covers big models on slow CPUs.
const TRANSCRIPTION_TIMEOUT_PER_AUDIO_SECOND_MS = 10000;
// Flat 60-minute cap when duration is unknown; a hung server must still fail.
const UNKNOWN_DURATION_TIMEOUT_MS = 3600000;
// 24-hour ceiling keeps the scaled value well under the 32-bit setTimeout limit.
const TRANSCRIPTION_TIMEOUT_CEILING_MS = 86400000;

function computeTranscriptionTimeoutMs(estimatedDurationSeconds) {
  if (!Number.isFinite(estimatedDurationSeconds) || estimatedDurationSeconds <= 0) {
    return UNKNOWN_DURATION_TIMEOUT_MS;
  }
  return Math.min(
    TRANSCRIPTION_TIMEOUT_CEILING_MS,
    Math.max(
      TRANSCRIPTION_TIMEOUT_FLOOR_MS,
      Math.ceil(estimatedDurationSeconds * TRANSCRIPTION_TIMEOUT_PER_AUDIO_SECOND_MS)
    )
  );
}

module.exports = {
  TRANSCRIPTION_TIMEOUT_FLOOR_MS,
  TRANSCRIPTION_TIMEOUT_PER_AUDIO_SECOND_MS,
  UNKNOWN_DURATION_TIMEOUT_MS,
  TRANSCRIPTION_TIMEOUT_CEILING_MS,
  computeTranscriptionTimeoutMs,
};
