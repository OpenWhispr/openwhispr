jest.mock('whisper.rn', () => ({
  initWhisper: jest.fn(),
}));

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: async () => ({ exists: true }),
  makeDirectoryAsync: async () => undefined,
  documentDirectory: '/doc/',
}));

import { LocalWhisperService } from '../LocalWhisperService';

describe('LocalWhisperService language handling', () => {
  const installFakeContext = (
    capture: { opts?: Record<string, unknown> },
    downloaded: string[],
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = LocalWhisperService as any;
    svc.whisperContext = {
      transcribe: (_uri: string, opts: Record<string, unknown>) => {
        capture.opts = opts;
        return { promise: Promise.resolve({ result: 'hi', segments: [], isAborted: false }) };
      },
    };
    svc.isAvailable = () => true;
    svc.getAvailableModels = async () =>
      ['base.en', 'base', 'tiny.en', 'tiny'].map((name) => ({
        name,
        downloaded: downloaded.includes(name),
        path: `/m/${name}.bin`,
      }));
    svc.getModelsDir = () => '/m/';
    svc.ensureModelInitialized = async () => undefined;
    svc.runExclusive = (fn: () => Promise<unknown>) => fn();
  };

  it('leaves language detection to Whisper when no hint is given', async () => {
    const capture: { opts?: Record<string, unknown> } = {};
    installFakeContext(capture, ['base']);
    await LocalWhisperService.transcribe('file://x.wav', { modelName: 'base' });
    expect(capture.opts).toMatchObject({ language: 'auto', translate: false });
  });

  it('keeps an explicit language and the legacy positional default', async () => {
    const capture: { opts?: Record<string, unknown> } = {};
    installFakeContext(capture, ['base']);
    await LocalWhisperService.transcribe('file://x.wav', { modelName: 'base', language: 'es' });
    expect(capture.opts).toMatchObject({ language: 'es' });

    await LocalWhisperService.transcribe('file://x.wav', 'base');
    expect(capture.opts).toMatchObject({ language: 'en' });
  });

  it('picks a multilingual model when there is no language hint, even if an English-only one is installed', async () => {
    installFakeContext({}, ['base.en', 'base', 'tiny.en', 'tiny']);
    await expect(LocalWhisperService.getRecommendedModelForLanguage(undefined)).resolves.toBe(
      'base',
    );
    await expect(LocalWhisperService.getRecommendedModelForLanguage('auto')).resolves.toBe('base');
    await expect(LocalWhisperService.getRecommendedModelForLanguage('en')).resolves.toBe('base.en');
    await expect(LocalWhisperService.getRecommendedModelForLanguage('es')).resolves.toBe('base');
  });
});
