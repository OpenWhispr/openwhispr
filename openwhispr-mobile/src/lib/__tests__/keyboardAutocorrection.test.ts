import {
  keyboardAutocorrectionSummary,
  normalizeKeyboardAutocorrectionLanguages,
  toggleKeyboardAutocorrectionLanguage,
} from '@/lib/keyboardAutocorrection';

describe('keyboard autocorrection languages', () => {
  it('defaults to German and English', () => {
    expect(normalizeKeyboardAutocorrectionLanguages(undefined)).toEqual(['de', 'en']);
    expect(normalizeKeyboardAutocorrectionLanguages([])).toEqual(['de', 'en']);
    expect(normalizeKeyboardAutocorrectionLanguages(['xx'])).toEqual(['de', 'en']);
  });

  it('keeps known codes once, in list order', () => {
    expect(normalizeKeyboardAutocorrectionLanguages(['en', 'xx', 'en'])).toEqual(['en']);
    expect(normalizeKeyboardAutocorrectionLanguages(['en', 'de'])).toEqual(['de', 'en']);
  });

  it('toggles a language but never removes the last one', () => {
    expect(toggleKeyboardAutocorrectionLanguage(['de', 'en'], 'en')).toEqual(['de']);
    expect(toggleKeyboardAutocorrectionLanguage(['de'], 'de')).toEqual(['de']);
    expect(toggleKeyboardAutocorrectionLanguage(['de'], 'en')).toEqual(['de', 'en']);
  });

  it('summarises the setting for the Settings row', () => {
    expect(keyboardAutocorrectionSummary(true, undefined)).toBe('German, English');
    expect(keyboardAutocorrectionSummary(true, ['en'])).toBe('English');
    expect(keyboardAutocorrectionSummary(false, ['en'])).toBe('Off');
  });
});
