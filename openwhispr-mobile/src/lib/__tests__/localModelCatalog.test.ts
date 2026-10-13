import { localModelLanguages } from '../localModelCatalog';

const labels = (model: Parameters<typeof localModelLanguages>[0]): string[] =>
  localModelLanguages(model).map((language) => language.label);

describe('localModelLanguages', () => {
  it('lists the 25 Parakeet v3 languages, with each English variant the app offers', () => {
    const languages = localModelLanguages('parakeet-v3');
    expect(new Set(languages.map((language) => language.code.split('-')[0])).size).toBe(25);
    expect(labels('parakeet-v3')).toEqual(
      expect.arrayContaining(['French', 'German', 'English (US)', 'English (UK)']),
    );
    expect(labels('parakeet-v3')).not.toContain('Hebrew');
  });

  it('lists only English for Parakeet v2', () => {
    expect(labels('parakeet-v2')).toEqual(['English (UK)', 'English (US)']);
  });

  it('lists every language the app offers for Whisper base, without Auto-detect', () => {
    expect(labels('whisper-base')).toContain('Hebrew');
    expect(labels('whisper-base')).not.toContain('Auto-detect');
    expect(localModelLanguages('whisper-base')).toHaveLength(59);
  });

  it('sorts languages by name', () => {
    const names = labels('whisper-base');
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
