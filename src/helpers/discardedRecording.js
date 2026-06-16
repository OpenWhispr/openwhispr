// Minimum recording length (seconds) worth preserving as a discarded record.
// Avoids saving accidental sub-second Escape taps. See #907.
export const MIN_DISCARDED_DURATION_SECONDS = 1;

export function shouldSaveDiscardedRecording(settings, durationSeconds) {
  if (!settings) return false;
  if (!settings.saveDiscardedTranscriptions) return false;
  if (!settings.dataRetentionEnabled) return false;
  if (!(settings.audioRetentionDays > 0)) return false;
  if (!(durationSeconds >= MIN_DISCARDED_DURATION_SECONDS)) return false;
  return true;
}
