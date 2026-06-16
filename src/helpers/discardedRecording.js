// Minimum recording length (seconds) worth preserving as a discarded record.
// Avoids saving accidental sub-second Escape taps. See #907.
const MIN_DISCARDED_DURATION_SECONDS = 1;

function shouldSaveDiscardedRecording(settings, durationSeconds) {
  if (!settings) return false;
  if (!settings.saveDiscardedTranscriptions) return false;
  if (!settings.dataRetentionEnabled) return false;
  if (!(settings.audioRetentionDays > 0)) return false;
  if (!(durationSeconds >= MIN_DISCARDED_DURATION_SECONDS)) return false;
  return true;
}

module.exports = { shouldSaveDiscardedRecording, MIN_DISCARDED_DURATION_SECONDS };
