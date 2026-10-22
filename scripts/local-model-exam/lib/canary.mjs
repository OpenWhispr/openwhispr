// The weekly canary's slice and pass marks; canary.mjs runs them.

// Errors per 100 words on these exact clips (the first three FLEURS clips of
// each language) in the first full exam, 2026-10-22. Three clips are too few to
// see a drift of a point or two, so a language fails only above
// measured × 1.5 + 10: enough to catch a broken engine, model file or audio
// path, and to ride out the streaming models' run-to-run wobble.
export const SPEECH_MODELS = {
  small: { en: 5.2, es: 0, de: 10.3 },
  "parakeet-tdt-0.6b-v3": { en: 6.9, es: 0, de: 11.5 },
  "nemotron-speech-streaming-en-0.6b": { en: 8.6 },
  "nemotron-3.5-asr-streaming-0.6b": { en: 29.3, es: 17.8, de: 15.4 },
};
export const CLIPS_PER_LANGUAGE = 3;
export const accuracyCeiling = (measured) => measured * 1.5 + 10;

// Silence and noise alone, then speech followed by silence, noise or a long
// pause. German is where Whisper Base and Turbo made words up on 2026-10-22.
export const SILENCE_CLIPS = [
  "silence-10s",
  "pink-40dbfs-5s",
  "trailing-silence-en",
  "trailing-silence-de",
  "mid-pause-en",
  "speech-then-noise-en",
];
export const SILENCE_RUNS = 3;

// Qwen3.5 2B passed every cleanup rule on all 66 cases on 2026-10-22, the only
// text model fast and faithful enough to be a default. These are the cases
// other models failed (they did what the dictation asked) plus one of each kind.
export const TEXT_MODELS = {
  "qwen3.5-2b-q4_k_m": [
    "en-n01",
    "en-s01",
    "en-i02",
    "en-i07",
    "en-q07",
    "en-q09",
    "de-i01",
    "ja-q01",
  ],
};

// Generous for shared runners: a hang should trip these, a slow machine not.
export const TIMEOUT_MS = { download: 15 * 60_000, load: 5 * 60_000, step: 3 * 60_000 };

// Why a cleanup fails the canary, or null when it passes every rule.
export function cleanupFailure(result, check) {
  if (!result.ok) return result.error || "failed";
  if (check.emptied) return "empty output";
  if (check.answered) return "did what the dictation asked instead of tidying it";
  if (check.echoedInstructions) return "printed its own instructions";
  if (!check.keptAll) return "dropped words it had to keep";
  return null;
}
