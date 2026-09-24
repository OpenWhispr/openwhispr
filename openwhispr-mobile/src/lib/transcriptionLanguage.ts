import { useConfigStore } from '@/store/useConfigStore';

/**
 * The user's full selected-language list as base ISO-639-1 codes (regional variants like
 * `en-GB`/`zh-CN` stripped), deduped. Empty array = auto-detect.
 *
 * Two config fields feed this, written by different screens: the Settings language screen
 * writes the single `preferredLanguage`, onboarding's multi-select writes `languages`. The
 * explicit Settings pick wins when present — and an explicit 'auto' there means auto-detect,
 * not "fall back to the onboarding list".
 */
export function getPreferredTranscriptionLanguages(): string[] {
  const config = useConfigStore.getState().config;

  const preferred = config?.preferredLanguage;
  if (preferred) {
    if (preferred === 'auto') return [];
    return [preferred.split('-')[0]];
  }

  const languages = config?.languages;
  if (!languages || languages.length === 0) return [];
  return [...new Set(languages.map((code) => code.split('-')[0]))];
}

/**
 * Picks the single-language hint for engines that accept one code (Whisper, the cloud API).
 * Returns the code only when exactly one language is selected, or undefined (auto-detect)
 * for zero or multiple selections.
 */
export function getPreferredTranscriptionLanguage(): string | undefined {
  const languages = getPreferredTranscriptionLanguages();
  return languages.length === 1 ? languages[0] : undefined;
}
