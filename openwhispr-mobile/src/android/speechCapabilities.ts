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
