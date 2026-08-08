import {
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
} from "../stores/policyRules.ts";

// Minimum recording length (seconds) worth preserving as a discarded record.
// Avoids saving accidental sub-second Escape taps. See #907.
export const MIN_DISCARDED_DURATION_SECONDS = 1;

export function shouldSaveDiscardedRecording(settings, durationSeconds, policyState = null) {
  if (!settings) return false;
  const dataRetentionEnabled = policyState
    ? effectiveLocalHistoryEnabled(policyState, settings.dataRetentionEnabled)
    : settings.dataRetentionEnabled;
  const audioRetentionDays = policyState
    ? effectiveAudioRetentionDays(policyState, settings.audioRetentionDays)
    : settings.audioRetentionDays;
  if (!settings.saveDiscardedTranscriptions) return false;
  if (!dataRetentionEnabled) return false;
  if (!(audioRetentionDays > 0)) return false;
  if (!(durationSeconds >= MIN_DISCARDED_DURATION_SECONDS)) return false;
  return true;
}
