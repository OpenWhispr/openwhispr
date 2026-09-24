import type { LocalEngineAvailability } from '@/services/transcription/localEngine';
import {
  LOCAL_MODEL_INSTALL_PEAK_BYTES,
  LOCAL_MODEL_SIZE_BYTES,
  getLocalModelCatalog,
  parakeetVersionForKey,
  recommendedModelKey,
} from '../localModelCatalog';

const availability = (
  overrides: Partial<LocalEngineAvailability> = {},
): LocalEngineAvailability => ({
  parakeetSupported: true,
  parakeetV2Downloaded: false,
  parakeetV3Downloaded: false,
  whisperDownloaded: false,
  orukeetSupported: true,
  orukeetDownloaded: false,
  ...overrides,
});

const keysFor = (languages: string[], overrides: Partial<LocalEngineAvailability> = {}): string[] =>
  getLocalModelCatalog(languages, availability(overrides)).map((entry) => entry.key);

describe('getLocalModelCatalog — Orukeet (opt-in)', () => {
  it('lists Orukeet but never recommends it', () => {
    for (const languages of [['en'], ['de'], ['en', 'fr'], [], ['ja']]) {
      const orukeet = getLocalModelCatalog(languages, availability()).find(
        (entry) => entry.key === 'orukeet',
      );
      expect(orukeet).toMatchObject({ title: 'Orukeet', recommended: false });
    }
  });

  it('keeps the recommended model first, so onboarding still downloads it', () => {
    expect(keysFor(['en'])).toEqual(['parakeet-v2', 'parakeet-v3', 'orukeet', 'whisper-base']);
    expect(keysFor(['de'])).toEqual(['parakeet-v3', 'parakeet-v2', 'orukeet', 'whisper-base']);
    expect(keysFor([])).toEqual(['whisper-base', 'parakeet-v2', 'parakeet-v3', 'orukeet']);
  });

  it('reflects whether Orukeet is downloaded', () => {
    const entry = getLocalModelCatalog(['en'], availability({ orukeetDownloaded: true })).find(
      (row) => row.key === 'orukeet',
    );
    expect(entry?.downloaded).toBe(true);
  });

  it('hides Orukeet with the Parakeet rows when the native module is unavailable', () => {
    expect(keysFor(['en'], { parakeetSupported: false })).toEqual(['whisper-base']);
  });

  it('hides only Orukeet on a binary that cannot install it', () => {
    expect(keysFor(['en'], { orukeetSupported: false })).toEqual([
      'parakeet-v2',
      'parakeet-v3',
      'whisper-base',
    ]);
  });

  it('never makes Orukeet the recommended download', () => {
    for (const languages of [['en'], ['de'], [], ['ja']]) {
      expect(recommendedModelKey(languages)).not.toBe('orukeet');
    }
  });
});

describe('getLocalModelCatalog — model in use', () => {
  const inUseKeys = (languages: string[], overrides: Partial<LocalEngineAvailability>): string[] =>
    getLocalModelCatalog(languages, availability(overrides))
      .filter((entry) => entry.inUse)
      .map((entry) => entry.key);

  it('marks Orukeet, not the recommended Parakeet row, once Orukeet serves the selection', () => {
    expect(inUseKeys(['en'], { parakeetV2Downloaded: true, orukeetDownloaded: true })).toEqual([
      'orukeet',
    ]);
  });

  it('marks the recommended Parakeet row when it is what dictation uses', () => {
    expect(inUseKeys(['de'], { parakeetV3Downloaded: true })).toEqual(['parakeet-v3']);
  });

  it('marks Whisper for auto-detect even when Orukeet is downloaded', () => {
    expect(inUseKeys([], { whisperDownloaded: true, orukeetDownloaded: true })).toEqual([
      'whisper-base',
    ]);
  });

  it('marks nothing when the selection has no installed model', () => {
    expect(inUseKeys(['en'], {})).toEqual([]);
  });
});

describe('parakeetVersionForKey', () => {
  it('maps Parakeet-runtime keys to their native version and Whisper to null', () => {
    expect(parakeetVersionForKey('parakeet-v2')).toBe('v2');
    expect(parakeetVersionForKey('parakeet-v3')).toBe('v3');
    expect(parakeetVersionForKey('orukeet')).toBe('orukeet');
    expect(parakeetVersionForKey('whisper-base')).toBeNull();
  });
});

describe('LOCAL_MODEL_INSTALL_PEAK_BYTES', () => {
  it('equals the installed size for models downloaded straight into place', () => {
    for (const key of ['whisper-base', 'parakeet-v2', 'parakeet-v3'] as const) {
      expect(LOCAL_MODEL_INSTALL_PEAK_BYTES[key]).toBe(LOCAL_MODEL_SIZE_BYTES[key]);
    }
  });

  it('covers the archive, its extraction and the compiled model coexisting during install', () => {
    // Measured from the pinned archive: the zip, its central-directory total and a compiled install.
    const archiveBytes = 554_985_744;
    const extractedBytes = 632_017_564;
    const compiledBytes = 632_191_599;
    expect(LOCAL_MODEL_SIZE_BYTES.orukeet).toBeGreaterThanOrEqual(compiledBytes);
    expect(LOCAL_MODEL_INSTALL_PEAK_BYTES.orukeet).toBeGreaterThanOrEqual(
      archiveBytes + extractedBytes + compiledBytes,
    );
  });
});
