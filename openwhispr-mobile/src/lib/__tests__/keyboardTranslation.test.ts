import {
  allTranslationLanguages,
  buildTranslatePrompt,
  coerceTranslationTarget,
  isTranslationApplicable,
  shouldTranslate,
  translationLabel,
  translationLanguagesFor,
} from '@/lib/keyboardTranslation';

describe('keyboardTranslation', () => {
  it('lists every registry language except auto', () => {
    const codes = allTranslationLanguages().map((l) => l.code);
    expect(codes).not.toContain('auto');
    expect(codes).toContain('es');
  });

  it('filters On-Device to the reported base languages', () => {
    const codes = translationLanguagesFor('local', ['en', 'es', 'zh']).map((l) => l.code);
    // The registry has en-US/en-GB and zh-CN/zh-TW, never bare base codes.
    expect(codes).toEqual(expect.arrayContaining(['en-US', 'en-GB', 'es', 'zh-CN', 'zh-TW']));
    expect(codes).not.toContain('th');
  });

  it('returns all languages On-Device when the list is unknown', () => {
    expect(translationLanguagesFor('local', null)).toEqual(allTranslationLanguages());
  });

  it('returns all languages for non-local modes', () => {
    expect(translationLanguagesFor('openwhispr', ['es'])).toEqual(allTranslationLanguages());
  });

  it('coerces a language the list lacks to null', () => {
    expect(coerceTranslationTarget('th', [{ code: 'es', label: 'Spanish' }])).toBeNull();
    expect(coerceTranslationTarget('es', [{ code: 'es', label: 'Spanish' }])).toBe('es');
    expect(coerceTranslationTarget(null, [{ code: 'es', label: 'Spanish' }])).toBeNull();
  });

  it('is not applicable for a guest on Cloud, with no route, or when cleanup is unavailable', () => {
    expect(
      isTranslationApplicable({ mode: 'openwhispr', cleanupUnavailable: false, guest: true }),
    ).toBe(false);
    expect(isTranslationApplicable({ mode: null, cleanupUnavailable: false, guest: false })).toBe(
      false,
    );
    expect(
      isTranslationApplicable({ mode: 'providers', cleanupUnavailable: true, guest: false }),
    ).toBe(false);
    expect(
      isTranslationApplicable({ mode: 'providers', cleanupUnavailable: false, guest: true }),
    ).toBe(true);
  });

  it('skips when source equals target and translates on auto', () => {
    expect(shouldTranslate('es', 'es')).toBe(false);
    expect(shouldTranslate('en-US', 'en-GB')).toBe(false);
    expect(shouldTranslate('auto', 'es')).toBe(true);
    expect(shouldTranslate(undefined, 'es')).toBe(true);
    expect(shouldTranslate('en', null)).toBe(false);
    expect(shouldTranslate('en', 'es')).toBe(true);
  });

  it('labels a code in English and falls back to the code', () => {
    expect(translationLabel('es')).toBe('Spanish');
    expect(translationLabel('xx')).toBe('xx');
  });

  it('substitutes the English label into the prompt', () => {
    const prompt = buildTranslatePrompt('es');
    expect(prompt).toContain('into Spanish.');
    expect(prompt).not.toContain('{{targetLanguage}}');
  });
});
