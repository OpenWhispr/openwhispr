const DEFAULT_WHISPER_VAD_CONFIG = Object.freeze({
  threshold: 0.5,
  minSpeechDurationMs: 250,
  minSilenceDurationMs: 200,
  maxSpeechDurationS: 30,
  speechPadMs: 100,
  samplesOverlap: 0.5,
});

const VAD_LIMITS = Object.freeze({
  threshold: { min: 0.1, max: 0.95 },
  minSpeechDurationMs: { min: 50, max: 2000 },
  minSilenceDurationMs: { min: 50, max: 2000 },
  maxSpeechDurationS: { min: 5, max: 120 },
  speechPadMs: { min: 0, max: 1000 },
  samplesOverlap: { min: 0, max: 0.95 },
});

function coerceNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeWhisperVadConfig(input = {}) {
  const merged = {
    ...DEFAULT_WHISPER_VAD_CONFIG,
    ...(input || {}),
  };

  return {
    threshold: clamp(
      coerceNumber(merged.threshold, DEFAULT_WHISPER_VAD_CONFIG.threshold),
      VAD_LIMITS.threshold.min,
      VAD_LIMITS.threshold.max
    ),
    minSpeechDurationMs: Math.round(
      clamp(
        coerceNumber(merged.minSpeechDurationMs, DEFAULT_WHISPER_VAD_CONFIG.minSpeechDurationMs),
        VAD_LIMITS.minSpeechDurationMs.min,
        VAD_LIMITS.minSpeechDurationMs.max
      )
    ),
    minSilenceDurationMs: Math.round(
      clamp(
        coerceNumber(merged.minSilenceDurationMs, DEFAULT_WHISPER_VAD_CONFIG.minSilenceDurationMs),
        VAD_LIMITS.minSilenceDurationMs.min,
        VAD_LIMITS.minSilenceDurationMs.max
      )
    ),
    maxSpeechDurationS: Math.round(
      clamp(
        coerceNumber(merged.maxSpeechDurationS, DEFAULT_WHISPER_VAD_CONFIG.maxSpeechDurationS),
        VAD_LIMITS.maxSpeechDurationS.min,
        VAD_LIMITS.maxSpeechDurationS.max
      )
    ),
    speechPadMs: Math.round(
      clamp(
        coerceNumber(merged.speechPadMs, DEFAULT_WHISPER_VAD_CONFIG.speechPadMs),
        VAD_LIMITS.speechPadMs.min,
        VAD_LIMITS.speechPadMs.max
      )
    ),
    samplesOverlap: clamp(
      coerceNumber(merged.samplesOverlap, DEFAULT_WHISPER_VAD_CONFIG.samplesOverlap),
      VAD_LIMITS.samplesOverlap.min,
      VAD_LIMITS.samplesOverlap.max
    ),
  };
}

function resolveContextSileroEnabled(settings = {}, context = "dictation") {
  if (context === "dictation") return settings.dictationSileroEnabled !== false;
  if (context === "noteRecording") return settings.noteRecordingSileroEnabled !== false;
  if (context === "meeting") return settings.meetingSileroEnabled !== false;
  return true;
}

module.exports = {
  DEFAULT_WHISPER_VAD_CONFIG,
  VAD_LIMITS,
  sanitizeWhisperVadConfig,
  resolveContextSileroEnabled,
};
