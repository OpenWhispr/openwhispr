// Pure resolver for the "retention-settings-changed" IPC sync. Both renderer
// windows re-sync on mount, so the handler needs to know whether the incoming
// values actually differ before kicking off another cleanup sweep.
const DEFAULT_RETENTION_SETTINGS = {
  audioRetentionDays: 30,
  transcriptRetentionDays: 0, // 0 = keep transcripts forever
};

function toDays(value, fallback) {
  const days = Math.trunc(Number(value));
  return Number.isFinite(days) && days >= 0 ? days : fallback;
}

function applyRetentionSettings(current, incoming) {
  const settings = {
    audioRetentionDays: toDays(incoming?.audioRetentionDays, current.audioRetentionDays),
    transcriptRetentionDays: toDays(
      incoming?.transcriptRetentionDays,
      current.transcriptRetentionDays
    ),
  };
  const changed =
    settings.audioRetentionDays !== current.audioRetentionDays ||
    settings.transcriptRetentionDays !== current.transcriptRetentionDays;
  return { changed, settings };
}

module.exports = { DEFAULT_RETENTION_SETTINGS, applyRetentionSettings };
