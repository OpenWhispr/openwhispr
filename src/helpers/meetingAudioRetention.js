// Minimum meeting length (seconds) worth keeping under audio retention.
const MIN_MEETING_AUDIO_RETENTION_SECONDS = 1;

function shouldSaveMeetingAudioRetention(settings, durationSeconds) {
  if (!settings) return false;
  if (!settings.dataRetentionEnabled) return false;
  if (!(settings.audioRetentionDays > 0)) return false;
  if (!(durationSeconds >= MIN_MEETING_AUDIO_RETENTION_SECONDS)) return false;
  return true;
}

module.exports = {
  MIN_MEETING_AUDIO_RETENTION_SECONDS,
  shouldSaveMeetingAudioRetention,
};
