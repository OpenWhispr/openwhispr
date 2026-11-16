import { useConfigStore } from '@/store/useConfigStore';
import { applyCloudConfig, applyPrivateConfig } from '../onboarding/setup';
import { initialLanguages } from '../onboarding/languages';

let mockLocale = 'pt_BR';
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { getLocale: () => mockLocale },
}));
jest.mock('../models', () => ({ modelSupported: () => true }));
jest.mock('@/store/useConfigStore', () => {
  const state: { config: unknown; updateConfig: unknown } = {
    config: undefined,
    updateConfig: null,
  };
  return {
    useConfigStore: {
      getState: () => state,
      setState: (next: object) => Object.assign(state, next),
    },
  };
});

const updateConfig = jest.fn(async () => {});
beforeEach(() => {
  updateConfig.mockClear();
  useConfigStore.setState({ config: undefined, updateConfig } as never);
});

describe('Cloud or Private', () => {
  it('Private keeps dictation, cleanup, notes and the assistant on the phone', async () => {
    await applyPrivateConfig();
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultMode: 'private',
        cloudBackupEnabled: false,
        androidSpeechModel: 'parakeet-v3',
        androidTextModel: 'qwen-small',
        inference: {
          dictation: { mode: 'local' },
          cleanup: { mode: 'local' },
          notes: { mode: 'local' },
          agent: { mode: 'local' },
        },
      }),
    );
  });

  it('Cloud drops the on-device picks but keeps a provider chosen in Settings', async () => {
    useConfigStore.setState({
      config: {
        defaultMode: 'private',
        inference: {
          dictation: { mode: 'local' },
          cleanup: { mode: 'providers', providerId: 'groq' },
        },
      },
    } as never);
    await applyCloudConfig();
    expect(updateConfig).toHaveBeenCalledWith({
      defaultMode: 'cloud',
      inference: { cleanup: { mode: 'providers', providerId: 'groq' } },
    });
  });
});

describe('starting languages', () => {
  it('uses the phone language when nothing is saved', () => {
    mockLocale = 'pt_BR';
    expect(initialLanguages(undefined)).toEqual(['pt']);
  });

  it('falls back to English for a language transcription does not list', () => {
    mockLocale = 'xx_YY';
    expect(initialLanguages(undefined)).toEqual(['en-US']);
  });

  it('keeps saved languages, as base codes, without duplicates', () => {
    expect(initialLanguages(['en-GB', 'en_GB', 'de'])).toEqual(['en-GB', 'de']);
    expect(initialLanguages(undefined, 'fr')).toEqual(['fr']);
    expect(initialLanguages(['en'])).toEqual(['en-US']);
    mockLocale = 'zh_TW';
    expect(initialLanguages(undefined)).toEqual(['zh-TW']);
  });
});
