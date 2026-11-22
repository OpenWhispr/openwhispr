// The languages the iOS keyboard can autocorrect. Each code needs a matching entry in the
// keyboard's KeyboardCorrectionLanguage table (plugins/keyboard-extension/ios/
// KeyboardAutocorrection.swift) with its dictionaries and letters; the keyboard ignores codes
// it doesn't know.
export const KEYBOARD_AUTOCORRECTION_LANGUAGES = [
  { code: 'de', label: 'German' },
  { code: 'en', label: 'English' },
] as const;

export type KeyboardAutocorrectionLanguage =
  (typeof KEYBOARD_AUTOCORRECTION_LANGUAGES)[number]['code'];

export const DEFAULT_KEYBOARD_AUTOCORRECTION_LANGUAGES: KeyboardAutocorrectionLanguage[] = [
  'de',
  'en',
];

// Every language is another dictionary lookup at each space, and words known to any of them
// are never corrected, so the selection stays small. The keyboard applies the same cap.
export const MAX_KEYBOARD_AUTOCORRECTION_LANGUAGES = 3;

const KNOWN = new Set<string>(KEYBOARD_AUTOCORRECTION_LANGUAGES.map((language) => language.code));

// Known codes only, without duplicates, in the list's order and capped; nothing left falls back
// to the default, since switching correction off is the separate switch's job.
export function normalizeKeyboardAutocorrectionLanguages(
  value: readonly string[] | null | undefined,
): KeyboardAutocorrectionLanguage[] {
  const picked = new Set((value ?? []).filter((code) => KNOWN.has(code)));
  const languages = KEYBOARD_AUTOCORRECTION_LANGUAGES.map((language) => language.code)
    .filter((code) => picked.has(code))
    .slice(0, MAX_KEYBOARD_AUTOCORRECTION_LANGUAGES);
  return languages.length > 0 ? languages : [...DEFAULT_KEYBOARD_AUTOCORRECTION_LANGUAGES];
}

// Tapping a language: add it (unless the cap is reached) or remove it (unless it is the last).
export function toggleKeyboardAutocorrectionLanguage(
  current: readonly string[],
  code: KeyboardAutocorrectionLanguage,
): KeyboardAutocorrectionLanguage[] {
  const languages = normalizeKeyboardAutocorrectionLanguages(current);
  if (languages.includes(code)) {
    return languages.length > 1 ? languages.filter((language) => language !== code) : languages;
  }
  if (languages.length >= MAX_KEYBOARD_AUTOCORRECTION_LANGUAGES) return languages;
  return normalizeKeyboardAutocorrectionLanguages([...languages, code]);
}

export function keyboardAutocorrectionSummary(
  enabled: boolean,
  languages: readonly string[] | null | undefined,
): string {
  if (!enabled) return 'Off';
  const picked = normalizeKeyboardAutocorrectionLanguages(languages);
  return KEYBOARD_AUTOCORRECTION_LANGUAGES.filter((language) => picked.includes(language.code))
    .map((language) => language.label)
    .join(', ');
}
