const mockSetMenuContext = jest.fn();
const mockUpdateConfig = jest.fn(async () => undefined);
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { setMenuContext: (context: unknown) => mockSetMenuContext(context) },
}));
jest.mock('../../../modules/android-dictation/src/appearance', () => ({
  setBubbleAppearance: jest.fn(),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: {}, updateConfig: mockUpdateConfig }) },
}));

import {
  DEFAULT_TRANSLATE_TARGET,
  TRANSLATE_LANGUAGES,
  currentTranslateTarget,
  languageForLocale,
  phoneLanguages,
  recentLanguages,
  saveTranslateTarget,
  searchLanguages,
  useTranslateRecents,
} from '../settings/translateLanguages';
import registry from '@/config/languageRegistry.json';

const codes = (list: { code: string }[]) => list.map((item) => item.code);

describe('Translate into', () => {
  it('lists the 60 languages of the registry, without Auto-detect', () => {
    expect(TRANSLATE_LANGUAGES).toHaveLength(60);
    expect(codes(TRANSLATE_LANGUAGES)).not.toContain('auto');
    expect(codes(TRANSLATE_LANGUAGES)).toEqual(
      registry.languages.filter((item) => item.code !== 'auto').map((item) => item.code),
    );
    // Every language has its own name, so the native-name search reaches all of them.
    expect(TRANSLATE_LANGUAGES.every((item) => item.native.length > 0)).toBe(true);
  });

  it('stays in Spanish until a language is picked', () => {
    expect(currentTranslateTarget(undefined)).toEqual(DEFAULT_TRANSLATE_TARGET);
    expect(DEFAULT_TRANSLATE_TARGET).toEqual({ code: 'es', label: 'Spanish' });
    expect(currentTranslateTarget({ code: 'de', label: 'German' })).toEqual({
      code: 'de',
      label: 'German',
    });
  });

  it('puts names that start with the search first, then names that contain it', () => {
    const found = codes(searchLanguages('ch'));
    expect(found.slice(0, 2)).toEqual(['zh-CN', 'zh-TW']);
    expect(found).toContain('cs'); // Czech
    expect(found).toContain('nl'); // Dutch
    expect(found.indexOf('zh-CN')).toBeLessThan(found.indexOf('cs'));
  });

  it('matches native names, ignoring case and accents', () => {
    expect(codes(searchLanguages('Deutsch'))).toEqual(['de']);
    expect(codes(searchLanguages('espanol'))).toEqual(['es']);
    expect(codes(searchLanguages('  FRAN '))).toEqual(['fr']);
    expect(codes(searchLanguages('日本'))).toEqual(['ja']);
  });

  it('finds nothing for a language it does not have', () => {
    expect(searchLanguages('Klingon')).toEqual([]);
  });

  it('maps the phone’s languages onto the list, once each', () => {
    expect(languageForLocale('de-AT')?.code).toBe('de');
    expect(languageForLocale('en-US')?.code).toBe('en-US');
    expect(languageForLocale('en-GB')?.code).toBe('en-GB');
    expect(languageForLocale('en-AU')?.code).toBe('en-GB');
    expect(languageForLocale('en-ZA')?.code).toBe('en-GB');
    expect(languageForLocale('en-CA')?.code).toBe('en-US');
    expect(languageForLocale('en')?.code).toBe('en-US');
    expect(languageForLocale('pt_BR')?.code).toBe('pt');
    expect(languageForLocale('zh-Hant-TW')?.code).toBe('zh-TW');
    expect(languageForLocale('zh-Hans-CN')?.code).toBe('zh-CN');
    expect(languageForLocale('zh-HK')?.code).toBe('zh-TW');
    expect(languageForLocale('nb-NO')?.code).toBe('no');
    expect(languageForLocale('iw-IL')?.code).toBe('he');
    expect(languageForLocale('fil-PH')?.code).toBe('tl');
    expect(languageForLocale('xx-YY')).toBeUndefined();
    expect(codes(phoneLanguages(['en-US', 'pt-BR', 'en-US', 'pt-PT', 'xx']))).toEqual([
      'en-US',
      'pt',
    ]);
  });

  it('keeps the last three picks, the current one first', () => {
    expect(codes(recentLanguages('es', []))).toEqual(['es']);
    expect(codes(recentLanguages('de', ['de', 'fr', 'es', 'it']))).toEqual(['de', 'fr', 'es']);
    expect(codes(recentLanguages('ja', ['de', 'nope']))).toEqual(['ja', 'de']);
  });

  it('saves a pick to the config the bubble reads, and to this phone’s recents', async () => {
    useTranslateRecents.setState({ codes: ['fr', 'es', 'it'] });
    await saveTranslateTarget(TRANSLATE_LANGUAGES.find((item) => item.code === 'de')!);
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      androidTranslationTarget: { code: 'de', label: 'German' },
    });
    // Spanish was the target (nothing saved), so it comes straight after the new pick.
    expect(useTranslateRecents.getState().codes).toEqual(['de', 'es', 'fr']);
  });

  it('keeps the language it replaces in Recent, even the Spanish it started on', async () => {
    useTranslateRecents.setState({ codes: [] });
    await saveTranslateTarget(TRANSLATE_LANGUAGES.find((item) => item.code === 'de')!);
    expect(useTranslateRecents.getState().codes).toEqual(['de', 'es']);
  });
});

describe('the Assistant switch', () => {
  const store = new Map<string, string>();
  beforeAll(() => {
    Object.assign(globalThis, {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        clear: () => store.clear(),
      },
    });
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  beforeEach(() => {
    jest.resetModules();
    mockSetMenuContext.mockClear();
    localStorage.clear();
  });
  const load = () =>
    require('../settings/bubbleAppearance') as typeof import('../settings/bubbleAppearance');

  it('is on by default', () => {
    expect(load().useBubbleAssistant.getState().on).toBe(true);
  });

  it('reads the old "Hold the bubble: Nothing" as off', () => {
    localStorage.setItem('android-bubble-hold-v1', 'nothing');
    expect(load().useBubbleAssistant.getState().on).toBe(false);
  });

  it('off makes a hold hold-to-talk on the bubble; on brings the menu back', () => {
    const { setBubbleAssistant, useBubbleAssistant } = load();
    setBubbleAssistant(false);
    expect(useBubbleAssistant.getState().on).toBe(false);
    expect(mockSetMenuContext).toHaveBeenLastCalledWith({ holdAction: 'talk' });
    expect(localStorage.getItem('android-bubble-hold-v1')).toBe('talk');
    setBubbleAssistant(true);
    expect(mockSetMenuContext).toHaveBeenLastCalledWith({ holdAction: 'menu' });
  });
});
