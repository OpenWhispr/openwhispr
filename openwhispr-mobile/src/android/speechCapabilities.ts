import type { AndroidSpeechModelId } from './speechSelection';

export const PARAKEET_LANGUAGES = new Set([
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
  'sk',
  'sl',
  'es',
  'sv',
  'ru',
  'uk',
]);
export function speechModelSupportsLanguages(
  model: AndroidSpeechModelId,
  languages: readonly string[],
): boolean {
  return languages.every((language) => {
    const base = language.toLowerCase().split(/[-_]/)[0];
    return (
      base === 'auto' || (model === 'parakeet-v3' ? PARAKEET_LANGUAGES.has(base) : base === 'en')
    );
  });
}

/** The listed languages a speech model can't transcribe, in the order listed. */
export function unsupportedSpeechLanguages(
  model: AndroidSpeechModelId,
  languages: readonly string[],
): string[] {
  return languages.filter((language) => !speechModelSupportsLanguages(model, [language]));
}

/**
 * Whether a recording can go to a speech model. The model detects the language itself, so one
 * listed language it knows is enough; an empty list means auto-detect.
 */
export function speechModelCoversRecording(
  model: AndroidSpeechModelId,
  languages: readonly string[],
): boolean {
  return (
    languages.length === 0 || unsupportedSpeechLanguages(model, languages).length < languages.length
  );
}
