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
  /** Apple Intelligence can't run now (off, downloading, unsupported); only read for `local`. */
  onDeviceUnavailable?: boolean;
}): boolean {
  if (input.mode === null || input.cleanupUnavailable) return false;
  // Cloud translation needs an account; BYOK and On-Device do not.
  if (input.mode === 'openwhispr' && input.guest) return false;
  if (input.mode === 'local' && input.onDeviceUnavailable) return false;
  return true;
}

/**
 * False when target is null, or source is set, not "auto", and is exactly the target (as desktop's
 * shouldRunTranslateStep). The dictation language comes without its region ("en"), so a regional
 * target (en-GB, zh-TW) always runs: the model hands the text back unchanged when it already is.
 */
export function shouldTranslate(source: string | null | undefined, target: string | null): boolean {
  if (target === null) return false;
  if (!source || source === 'auto') return true;
  return source !== target;
}

/** English label, falls back to the code. */
export function translationLabel(code: string): string {
  return registry.languages.find((language) => language.code === code)?.label ?? code;
}

/** The warning a translation that didn't happen leaves in History. */
export function translationFailureReason(target: string): string {
  return `Couldn't translate to ${translationLabel(target)}. The text was left untranslated.`;
}

// History has one warning line, and a cleanup failure must not hide that the text wasn't
// translated. With cleanup unavailable, both steps skip for the same reason; say it once.
export function withTranslationWarning(cleanupWarning: string | undefined, reason: string): string {
  if (!cleanupWarning) return reason;
  if (cleanupWarning.includes(reason)) return cleanupWarning;
  return `${cleanupWarning} ${reason}`;
}

export function buildTranslatePrompt(targetCode: string): string {
  return DEFAULT_TRANSLATE_PROMPT.split(TARGET_LANGUAGE_PLACEHOLDER).join(
    translationLabel(targetCode),
  );
}
