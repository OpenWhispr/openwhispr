import registry from '@/config/languageRegistry.json';
import { useConfigStore } from '@/store/useConfigStore';

export type TranslateLanguage = { code: string; label: string; native: string };

/** What Translate writes in until someone picks a language (the pipeline's own default). */
export const DEFAULT_TRANSLATE_TARGET = { code: 'es', label: 'Spanish' } as const;

// Each language's own name, so "Deutsch" finds German. The list is the app's copy of desktop's
// language registry (src/config/languageRegistry.json) without Auto-detect.
const NATIVE: Record<string, string> = {
  af: 'Afrikaans',
  ar: 'العربية',
  hy: 'Հայերեն',
  az: 'Azərbaycan',
  be: 'Беларуская',
  bs: 'Bosanski',
  bg: 'Български',
  ca: 'Català',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  hr: 'Hrvatski',
  cs: 'Čeština',
  da: 'Dansk',
  nl: 'Nederlands',
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  et: 'Eesti',
  fi: 'Suomi',
  fr: 'Français',
  gl: 'Galego',
  de: 'Deutsch',
  el: 'Ελληνικά',
  he: 'עברית',
  hi: 'हिन्दी',
  hu: 'Magyar',
  is: 'Íslenska',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  kn: 'ಕನ್ನಡ',
  kk: 'Қазақ',
  ko: '한국어',
  lv: 'Latviešu',
  lt: 'Lietuvių',
  mk: 'Македонски',
  ms: 'Bahasa Melayu',
  mt: 'Malti',
  mr: 'मराठी',
  mi: 'Te Reo Māori',
  ne: 'नेपाली',
  no: 'Norsk',
  fa: 'فارسی',
  pl: 'Polski',
  pt: 'Português',
  ro: 'Română',
  ru: 'Русский',
  sr: 'Српски',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  es: 'Español',
  sw: 'Kiswahili',
  sv: 'Svenska',
  tl: 'Tagalog',
  ta: 'தமிழ்',
  th: 'ไทย',
  tr: 'Türkçe',
  uk: 'Українська',
  ur: 'اردو',
  vi: 'Tiếng Việt',
  cy: 'Cymraeg',
};

export const TRANSLATE_LANGUAGES: TranslateLanguage[] = registry.languages
  .filter((item) => item.code !== 'auto')
  .map(({ code, label }) => ({ code, label, native: NATIVE[code] ?? label }));

const byCode = new Map(TRANSLATE_LANGUAGES.map((item) => [item.code, item]));
export const languageByCode = (code: string | undefined) => (code ? byCode.get(code) : undefined);

// Old or alternative tags Android still reports, and scripts that pick a Chinese variant.
const ALIASES: Record<string, string> = {
  iw: 'he',
  in: 'id',
  nb: 'no',
  nn: 'no',
  fil: 'tl',
  'zh-hans': 'zh-CN',
  'zh-hant': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  'zh-sg': 'zh-CN',
};

// English locales that spell the British way ("colour"), so the phone's English (South Africa)
// offers English (UK).
const BRITISH_SPELLING = new Set([
  'gb',
  'ie',
  'au',
  'nz',
  'za',
  'in',
  'sg',
  'hk',
  'mt',
  'ke',
  'ng',
]);

/** The list's language for one of the phone's locale tags ("de-AT" → German), if it has one. */
export function languageForLocale(tag: string): TranslateLanguage | undefined {
  const parts = tag.replaceAll('_', '-').split('-').filter(Boolean);
  if (!parts.length) return undefined;
  const lang = parts[0].toLowerCase();
  const next = parts[1]?.toLowerCase();
  const exact = TRANSLATE_LANGUAGES.find(
    (item) => item.code.toLowerCase() === `${lang}-${next ?? ''}`,
  );
  if (exact) return exact;
  if (lang === 'zh') {
    const script = parts.find((part) => /^han[st]$/i.test(part))?.toLowerCase();
    const alias = ALIASES[`zh-${script ?? next ?? 'hans'}`] ?? 'zh-CN';
    return byCode.get(alias);
  }
  if (lang === 'en') return byCode.get(next && BRITISH_SPELLING.has(next) ? 'en-GB' : 'en-US');
  return byCode.get(ALIASES[lang] ?? lang);
}

/** The phone's own languages (Settings › System › Languages), in its order, once each. */
export function phoneLanguages(tags: readonly string[]): TranslateLanguage[] {
  const found: TranslateLanguage[] = [];
  for (const tag of tags) {
    const language = languageForLocale(tag);
    if (language && !found.includes(language)) found.push(language);
  }
  return found;
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/**
 * Languages whose English or native name matches [query]: names that start with it first (or a
 * word in them, "Chinese (Traditional)" for "trad"), then names that contain it. Case and
 * accents are ignored.
 */
export function searchLanguages(query: string): TranslateLanguage[] {
  const needle = fold(query);
  if (!needle) return TRANSLATE_LANGUAGES;
  const starts: TranslateLanguage[] = [];
  const words: TranslateLanguage[] = [];
  const contains: TranslateLanguage[] = [];
  for (const item of TRANSLATE_LANGUAGES) {
    const names = [fold(item.label), fold(item.native)];
    if (names.some((name) => name.startsWith(needle))) starts.push(item);
    else if (names.some((name) => name.split(/[\s()]+/).some((word) => word.startsWith(needle))))
      words.push(item);
    else if (names.some((name) => name.includes(needle))) contains.push(item);
  }
  return [...starts, ...words, ...contains];
}

/** The language Translate writes in: the saved one, or Spanish. */
export function currentTranslateTarget(saved: { code: string; label: string } | undefined): {
  code: string;
  label: string;
} {
  return saved?.code && saved.label ? saved : DEFAULT_TRANSLATE_TARGET;
}

/** Saves the pick to the account config; the bubble reads it from there. */
export async function saveTranslateTarget(language: TranslateLanguage): Promise<void> {
  await useConfigStore
    .getState()
    .updateConfig({ androidTranslationTarget: { code: language.code, label: language.label } });
}
