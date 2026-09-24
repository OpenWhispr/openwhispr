import type { ParakeetVersion } from '../../../modules/parakeet-asr/src';

/**
 * Pure routing policy for on-device transcription: which local engine handles the user's
 * selected languages. No I/O — availability is passed in — so the full matrix is unit-testable.
 */

export interface LocalEngineAvailability {
  /** Native module linked (iOS dev/prod build; false on Android and Expo Go). */
  parakeetSupported: boolean;
  parakeetV2Downloaded: boolean;
  parakeetV3Downloaded: boolean;
  whisperDownloaded: boolean;
}

export type LocalEngineChoice =
  | { engine: 'parakeet'; version: ParakeetVersion }
  | { engine: 'whisper' }
  | { engine: 'none'; preferred: 'parakeet-v2' | 'parakeet-v3' | 'whisper' };

/**
 * The 25 languages of NVIDIA parakeet-tdt-0.6b-v3 (per the official model card). FluidAudio
 * 0.15.4's `Language` enum (Sources/FluidAudio/Shared/TokenLanguageFilter.swift) is a superset —
 * every code here has an enum case, so the per-language decoder hint works for all of them.
 */
export const PARAKEET_V3_LANGUAGES: ReadonlySet<string> = new Set([
  'bg',
  'hr',
  'cs',
  'da',
  'nl',
  'en',
  'et',
  'fi',
  'fr',
  'de',
  'el',
  'hu',
  'it',
  'lv',
  'lt',
  'mt',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'es',
  'sv',
  'uk',
]);

/** Region-stripped, deduped base ISO codes with 'auto'/empties removed. */
function normalizeLanguages(languages: readonly string[]): string[] {
  const normalized = languages
    .map((code) => code.trim().toLowerCase().split('-')[0])
    .filter((code) => code.length > 0 && code !== 'auto');
  return [...new Set(normalized)];
}

/**
 * The engine the user's language selection *should* use, ignoring what's downloaded:
 * - exactly English → Parakeet v2 (fastest and most accurate for English)
 * - one or more languages, all inside v3's set → Parakeet v3 (auto language ID across them)
 * - empty ('auto') or anything outside v3's coverage → Whisper (attempts all ~99 languages)
 *
 * Per-recording engine routing is impossible — the spoken language isn't known before
 * transcription — so a mixed selection like en+he must go to Whisper for everything.
 */
export function preferredEngineForLanguages(
  languages: readonly string[],
): { engine: 'parakeet'; version: ParakeetVersion } | { engine: 'whisper' } {
  const normalized = normalizeLanguages(languages);
  if (normalized.length === 0) {
    return { engine: 'whisper' };
  }
  if (normalized.length === 1 && normalized[0] === 'en') {
    return { engine: 'parakeet', version: 'v2' };
  }
  if (normalized.every((code) => PARAKEET_V3_LANGUAGES.has(code))) {
    return { engine: 'parakeet', version: 'v3' };
  }
  return { engine: 'whisper' };
}

/**
 * Resolve the preferred engine against what's actually installed. Fallback order: preferred
 * Parakeet → Whisper if downloaded → 'none' (caller surfaces a download prompt). Whisper-bound
 * selections never fall "up" to Parakeet — it can't cover them.
 */
export function selectLocalEngine(
  languages: readonly string[],
  availability: LocalEngineAvailability,
): LocalEngineChoice {
  const preferred = preferredEngineForLanguages(languages);

  if (preferred.engine === 'parakeet' && availability.parakeetSupported) {
    const downloaded =
      preferred.version === 'v2'
        ? availability.parakeetV2Downloaded
        : availability.parakeetV3Downloaded;
    if (downloaded) {
      return preferred;
    }
    if (availability.whisperDownloaded) {
      return { engine: 'whisper' };
    }
    return {
      engine: 'none',
      preferred: preferred.version === 'v2' ? 'parakeet-v2' : 'parakeet-v3',
    };
  }

  if (availability.whisperDownloaded) {
    return { engine: 'whisper' };
  }
  return { engine: 'none', preferred: 'whisper' };
}
