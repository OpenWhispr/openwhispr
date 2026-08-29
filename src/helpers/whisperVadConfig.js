const { DEFAULTS, LIMITS } = require("../constants/whisperVad.json");

const DEFAULT_WHISPER_VAD_CONFIG = Object.freeze({ ...DEFAULTS });
const VAD_LIMITS = Object.freeze(LIMITS);

function clampVadField(key, value) {
  const fallback = DEFAULTS[key];
  const n = value === null || value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback !== undefined ? fallback : value;
  const limit = LIMITS[key];
  if (!limit) return n;
  const { min, max, round } = limit;
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
  // Dictation is opt-in: VAD on pause-heavy dictations can strip the speech and
  // leave Whisper decoding near-silence seeded with the dictionary prompt, which
  // replaces the transcript with dictionary words (#1454). Long-form contexts
  // (notes, meetings) keep VAD to skip extended silence.
  const normalizedContext =
    typeof context === "string" ? context.trim().toLowerCase() : "dictation";

  if (normalizedContext === "dictation") return settings?.dictationSileroEnabled === true;
  if (normalizedContext === "noterecording" || normalizedContext === "note_recording") {
    return settings?.noteRecordingSileroEnabled !== false;
  }
  if (normalizedContext === "meeting") return settings?.meetingSileroEnabled !== false;
  return true;
}

module.exports = {
  DEFAULT_WHISPER_VAD_CONFIG,
  VAD_LIMITS,
  clampVadField,
  sanitizeWhisperVadConfig,
  resolveContextSileroEnabled,
};
