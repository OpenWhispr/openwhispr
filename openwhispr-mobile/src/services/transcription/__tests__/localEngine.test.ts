import {
  PARAKEET_FAMILY_LANGUAGES,
  parakeetModelLabel,
  preferredEngineForLanguages,
  selectLocalEngine,
  type LocalEngineAvailability,
} from '../localEngine';

const all = (overrides: Partial<LocalEngineAvailability> = {}): LocalEngineAvailability => ({
  parakeetSupported: true,
  parakeetV2Downloaded: true,
  parakeetV3Downloaded: true,
  whisperDownloaded: true,
  orukeetSupported: true,
  // Orukeet is opt-in: absent unless a test downloads it.
  orukeetDownloaded: false,
  ...overrides,
});

describe('preferredEngineForLanguages', () => {
  it('routes exactly English to Parakeet v2', () => {
    expect(preferredEngineForLanguages(['en'])).toEqual({ engine: 'parakeet', version: 'v2' });
  });

  it('strips regions and dedupes before deciding', () => {
    expect(preferredEngineForLanguages(['en-US', 'en-GB'])).toEqual({
      engine: 'parakeet',
      version: 'v2',
    });
  });

  it('routes a single v3 language to Parakeet v3', () => {
    for (const code of ['de', 'fr', 'es', 'uk', 'mt']) {
      expect(preferredEngineForLanguages([code])).toEqual({ engine: 'parakeet', version: 'v3' });
    }
  });

  it('routes a multi-selection fully inside v3 to Parakeet v3 (incl. English)', () => {
    expect(preferredEngineForLanguages(['en', 'de'])).toEqual({
      engine: 'parakeet',
      version: 'v3',
    });
    expect(preferredEngineForLanguages(['fr', 'it', 'pt'])).toEqual({
      engine: 'parakeet',
      version: 'v3',
    });
  });

  it('routes mixed selections with any non-v3 language to Whisper', () => {
    expect(preferredEngineForLanguages(['en', 'he'])).toEqual({ engine: 'whisper' });
    expect(preferredEngineForLanguages(['en', 'ja'])).toEqual({ engine: 'whisper' });
  });

  it('routes auto/empty and unsupported single languages to Whisper', () => {
    expect(preferredEngineForLanguages([])).toEqual({ engine: 'whisper' });
    expect(preferredEngineForLanguages(['auto'])).toEqual({ engine: 'whisper' });
    expect(preferredEngineForLanguages(['ja'])).toEqual({ engine: 'whisper' });
    expect(preferredEngineForLanguages(['zh-CN'])).toEqual({ engine: 'whisper' });
  });

  it('covers exactly the 25 official v3 languages', () => {
    expect(PARAKEET_FAMILY_LANGUAGES.size).toBe(25);
    expect(PARAKEET_FAMILY_LANGUAGES.has('he')).toBe(false);
    expect(PARAKEET_FAMILY_LANGUAGES.has('sr')).toBe(false);
  });
});

describe('selectLocalEngine', () => {
  it('uses the preferred Parakeet when downloaded', () => {
    expect(selectLocalEngine(['en'], all())).toEqual({ engine: 'parakeet', version: 'v2' });
    expect(selectLocalEngine(['de'], all())).toEqual({ engine: 'parakeet', version: 'v3' });
  });

  it('falls back to Whisper when the preferred Parakeet is not downloaded', () => {
    expect(selectLocalEngine(['en'], all({ parakeetV2Downloaded: false }))).toEqual({
      engine: 'whisper',
    });
    expect(selectLocalEngine(['de'], all({ parakeetV3Downloaded: false }))).toEqual({
      engine: 'whisper',
    });
  });

  it('reports the missing preferred model when nothing is downloaded', () => {
    expect(
      selectLocalEngine(['en'], all({ parakeetV2Downloaded: false, whisperDownloaded: false })),
    ).toEqual({ engine: 'none', preferred: 'parakeet-v2' });
    expect(
      selectLocalEngine(['de'], all({ parakeetV3Downloaded: false, whisperDownloaded: false })),
    ).toEqual({ engine: 'none', preferred: 'parakeet-v3' });
    expect(selectLocalEngine([], all({ whisperDownloaded: false }))).toEqual({
      engine: 'none',
      preferred: 'whisper',
    });
  });

  it('always routes to Whisper when the native module is unsupported (Android/Expo Go)', () => {
    expect(selectLocalEngine(['en'], all({ parakeetSupported: false }))).toEqual({
      engine: 'whisper',
    });
    expect(
      selectLocalEngine(['en'], all({ parakeetSupported: false, whisperDownloaded: false })),
    ).toEqual({ engine: 'none', preferred: 'whisper' });
  });

  it('never falls "up" to Parakeet for Whisper-bound selections', () => {
    expect(selectLocalEngine(['ja'], all({ whisperDownloaded: false }))).toEqual({
      engine: 'none',
      preferred: 'whisper',
    });
  });
});

describe('selectLocalEngine with Orukeet downloaded (opt-in)', () => {
  const withOrukeet = (overrides: Partial<LocalEngineAvailability> = {}): LocalEngineAvailability =>
    all({ orukeetDownloaded: true, ...overrides });

  it('uses Orukeet for English even when Parakeet v2 is installed', () => {
    expect(selectLocalEngine(['en'], withOrukeet())).toEqual({
      engine: 'parakeet',
      version: 'orukeet',
    });
  });

  it('uses Orukeet for in-set selections even when Parakeet v3 is installed', () => {
    expect(selectLocalEngine(['de'], withOrukeet())).toEqual({
      engine: 'parakeet',
      version: 'orukeet',
    });
    expect(selectLocalEngine(['de', 'fr'], withOrukeet())).toEqual({
      engine: 'parakeet',
      version: 'orukeet',
    });
  });

  it('serves in-set selections when it is the only local model', () => {
    const onlyOrukeet = withOrukeet({
      parakeetV2Downloaded: false,
      parakeetV3Downloaded: false,
      whisperDownloaded: false,
    });
    expect(selectLocalEngine(['en-US'], onlyOrukeet)).toEqual({
      engine: 'parakeet',
      version: 'orukeet',
    });
  });

  it('never handles auto or out-of-set selections', () => {
    expect(selectLocalEngine([], withOrukeet())).toEqual({ engine: 'whisper' });
    expect(selectLocalEngine(['auto'], withOrukeet())).toEqual({ engine: 'whisper' });
    expect(selectLocalEngine(['en', 'he'], withOrukeet())).toEqual({ engine: 'whisper' });
    expect(selectLocalEngine(['ja'], withOrukeet({ whisperDownloaded: false }))).toEqual({
      engine: 'none',
      preferred: 'whisper',
    });
  });

  it('is ignored when the native module is unsupported', () => {
    expect(selectLocalEngine(['en'], withOrukeet({ parakeetSupported: false }))).toEqual({
      engine: 'whisper',
    });
  });

  it('leaves the preferred engine (and so every recommendation) unchanged', () => {
    expect(preferredEngineForLanguages(['en'])).toEqual({ engine: 'parakeet', version: 'v2' });
    expect(preferredEngineForLanguages(['de'])).toEqual({ engine: 'parakeet', version: 'v3' });
  });
});

describe('parakeetModelLabel', () => {
  it('names every shipped model for display and error messages', () => {
    expect(parakeetModelLabel('v2')).toBe('Parakeet v2');
    expect(parakeetModelLabel('v3')).toBe('Parakeet v3');
    expect(parakeetModelLabel('orukeet')).toBe('Orukeet');
  });
});
