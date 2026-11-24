import registry from '@/config/languageRegistry.json';
import { DEFAULT_TRANSLATE_PROMPT } from '@/config/prompts/registry';

export interface TranslationLanguage {
  code: string;
  label: string;
}

export type CleanupRouteMode = 'openwhispr' | 'providers' | 'local' | null;

const TARGET_LANGUAGE_PLACEHOLDER = '{{targetLanguage}}';

function baseLanguage(code: string): string {
  return code.split('-')[0].toLowerCase();
}

/** languageRegistry.json minus "auto", in registry order. */
export function allTranslationLanguages(): TranslationLanguage[] {
  return registry.languages
    .filter((language) => language.code !== 'auto')
    .map(({ code, label }) => ({ code, label }));
}

/** `local` filters to onDeviceCodes by base language; null onDeviceCodes (unknown) returns all. */
export function translationLanguagesFor(
  mode: CleanupRouteMode,
  onDeviceCodes: string[] | null,
): TranslationLanguage[] {
  const all = allTranslationLanguages();
  if (mode !== 'local' || onDeviceCodes === null) return all;
  const supported = new Set(onDeviceCodes.map(baseLanguage));
  return all.filter((language) => supported.has(baseLanguage(language.code)));
}

/** The code when it is in `languages`, else null. */
export function coerceTranslationTarget(
  value: string | null | undefined,
  languages: TranslationLanguage[],
): string | null {
  if (!value) return null;
  return languages.some((language) => language.code === value) ? value : null;
}

export function isTranslationApplicable(input: {
  mode: CleanupRouteMode;
  cleanupUnavailable: boolean;
  guest: boolean;
}): boolean {
  if (input.mode === null || input.cleanupUnavailable) return false;
  // Cloud translation needs an account; BYOK and On-Device do not.
  if (input.mode === 'openwhispr' && input.guest) return false;
  return true;
}

/** False when target is null, or source is set, not "auto", and has the same base language. */
export function shouldTranslate(source: string | null | undefined, target: string | null): boolean {
  if (target === null) return false;
  if (!source || source === 'auto') return true;
  return baseLanguage(source) !== baseLanguage(target);
}

/** English label, falls back to the code. */
export function translationLabel(code: string): string {
  return registry.languages.find((language) => language.code === code)?.label ?? code;
}

export function buildTranslatePrompt(targetCode: string): string {
  return DEFAULT_TRANSLATE_PROMPT.split(TARGET_LANGUAGE_PLACEHOLDER).join(
    translationLabel(targetCode),
  );
}
