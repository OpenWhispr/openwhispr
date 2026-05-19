const { DEFAULTS, LIMITS } = require("../constants/whisperVad.json");

const DEFAULT_WHISPER_VAD_CONFIG = Object.freeze({ ...DEFAULTS });
const VAD_LIMITS = Object.freeze(LIMITS);

function clampVadField(key, value) {
  const fallback = DEFAULTS[key];
  const n = value === null || value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const { min, max, round } = LIMITS[key];
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
}

function sanitizeWhisperVadConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input || {}) };
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = clampVadField(key, merged[key]);
  }
  return out;
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
  clampVadField,
  sanitizeWhisperVadConfig,
  resolveContextSileroEnabled,
};
