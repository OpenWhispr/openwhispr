jest.mock('../LocalWhisperService', () => ({
  LocalWhisperService: {
    isAvailable: jest.fn(() => true),
    getAvailableModels: jest.fn(async () => [{ name: 'base', size: 1, downloaded: true }]),
    getRecommendedModelForLanguage: jest.fn(async () => 'base'),
    transcribe: jest.fn(async () => ({ text: 'whisper text', duration: 1, provider: 'local' })),
    prepareForLanguage: jest.fn(async () => undefined),
    cancelTranscription: jest.fn(async () => undefined),
    cleanup: jest.fn(async () => undefined),
  },
}));
jest.mock('../LocalParakeetService', () => ({
  LocalParakeetService: {
    isAvailable: jest.fn(() => true),
    supportsVersion: jest.fn(() => true),
    isModelDownloaded: jest.fn(async () => true),
    isModelDownloadedAfterRecovery: jest.fn(async () => true),
    hasFailedToLoad: jest.fn(() => false),
    transcribe: jest.fn(async () => ({ text: 'parakeet text', duration: 2, provider: 'local' })),
    prepare: jest.fn(async () => undefined),
    cancelTranscription: jest.fn(async () => undefined),
    cleanup: jest.fn(async () => undefined),
  },
}));
jest.mock('../../../lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: jest.fn(() => []),
  getPreferredTranscriptionLanguage: jest.fn(() => undefined),
}));

import { LocalWhisperService } from '../LocalWhisperService';
import { LocalParakeetService } from '../LocalParakeetService';
import { getPreferredTranscriptionLanguages } from '../../../lib/transcriptionLanguage';
import { LocalTranscriptionService } from '../LocalTranscriptionService';

const mockWhisper = LocalWhisperService as jest.Mocked<typeof LocalWhisperService>;
const mockParakeet = LocalParakeetService as jest.Mocked<typeof LocalParakeetService>;
const mockGetLanguages = getPreferredTranscriptionLanguages as jest.MockedFunction<
  typeof getPreferredTranscriptionLanguages
>;

const setLanguages = (languages: string[]): void => {
  mockGetLanguages.mockReturnValue(languages);
};

describe('LocalTranscriptionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setLanguages([]);
    mockWhisper.isAvailable.mockReturnValue(true);
    mockWhisper.getAvailableModels.mockResolvedValue([{ name: 'base', size: 1, downloaded: true }]);
    mockWhisper.getRecommendedModelForLanguage.mockResolvedValue('base');
    mockWhisper.transcribe.mockResolvedValue({
      text: 'whisper text',
      duration: 1,
      provider: 'local',
    });
    mockParakeet.isAvailable.mockReturnValue(true);
    mockParakeet.supportsVersion.mockReturnValue(true);
    mockParakeet.hasFailedToLoad.mockReturnValue(false);
    // Parakeet v2/v3 installed; Orukeet is opt-in and absent unless a test downloads it.
    mockParakeet.isModelDownloaded.mockImplementation(async (version) => version !== 'orukeet');
    mockParakeet.transcribe.mockResolvedValue({
      text: 'parakeet text',
      duration: 2,
      provider: 'local',
    });
  });

  it('routes English dictation to Parakeet v2 with the language hint', async () => {
    setLanguages(['en']);
    const response = await LocalTranscriptionService.transcribe('file://a.wav', {
      language: 'en',
      prompt: 'hint words',
    });
    expect(mockParakeet.transcribe).toHaveBeenCalledWith('file://a.wav', {
      version: 'v2',
      language: 'en',
      wordTimestamps: undefined,
    });
    // Idle whisper context is released so both runtimes are never resident together.
    expect(mockWhisper.cleanup).toHaveBeenCalled();
    expect(mockWhisper.transcribe).not.toHaveBeenCalled();
    expect(response.endpoint).toBe('parakeet-v2');
  });

  it('routes a fully-v3 multi-selection to v3 with auto language ID (no hint)', async () => {
    setLanguages(['en', 'de']);
    const response = await LocalTranscriptionService.transcribe('file://a.wav', {});
    expect(mockParakeet.transcribe).toHaveBeenCalledWith('file://a.wav', {
      version: 'v3',
      language: undefined,
      wordTimestamps: undefined,
    });
    expect(response.endpoint).toBe('parakeet-v3');
  });

  it('routes in-set selections to a downloaded Orukeet ahead of Parakeet v2/v3', async () => {
    mockParakeet.isModelDownloaded.mockResolvedValue(true);
    setLanguages(['en']);
    const response = await LocalTranscriptionService.transcribe('file://a.wav', {
      language: 'en',
      wordTimestamps: true,
    });
    expect(mockParakeet.transcribe).toHaveBeenCalledWith('file://a.wav', {
      version: 'orukeet',
      language: 'en',
      wordTimestamps: true,
    });
    expect(mockWhisper.cleanup).toHaveBeenCalled();
    expect(response.endpoint).toBe('orukeet');
  });

  it('reports whether Orukeet is downloaded', async () => {
    await expect(LocalTranscriptionService.getAvailability()).resolves.toMatchObject({
      parakeetV2Downloaded: true,
      parakeetV3Downloaded: true,
      orukeetSupported: true,
      orukeetDownloaded: false,
    });
    expect(mockParakeet.isModelDownloaded).toHaveBeenCalledWith('orukeet');
    expect(mockParakeet.isModelDownloadedAfterRecovery).not.toHaveBeenCalled();
  });

  it('waits for Orukeet recovery when the model picker requests availability', async () => {
    await expect(
      LocalTranscriptionService.getAvailability({ waitForRecovery: true }),
    ).resolves.toMatchObject({
      orukeetDownloaded: true,
    });
    expect(mockParakeet.isModelDownloadedAfterRecovery).toHaveBeenCalledWith('orukeet');
    expect(mockParakeet.isModelDownloaded).not.toHaveBeenCalledWith('orukeet');
  });

  it('reports Orukeet unsupported, and never asks for it, on a binary that predates it', async () => {
    mockParakeet.supportsVersion.mockImplementation((version) => version !== 'orukeet');
    await expect(LocalTranscriptionService.getAvailability()).resolves.toMatchObject({
      parakeetV2Downloaded: true,
      orukeetSupported: false,
      orukeetDownloaded: false,
    });
    expect(mockParakeet.isModelDownloaded).not.toHaveBeenCalledWith('orukeet');
  });

  describe('when an installed Orukeet fails to load', () => {
    beforeEach(() => {
      mockParakeet.isModelDownloaded.mockResolvedValue(true);
      setLanguages(['en']);
    });

    it('reroutes that dictation to the model it would otherwise use', async () => {
      let failed = false;
      mockParakeet.hasFailedToLoad.mockImplementation(() => failed);
      mockParakeet.transcribe.mockImplementationOnce(async () => {
        failed = true;
        throw new Error('Core ML could not load Encoder.mlmodelc');
      });

      const response = await LocalTranscriptionService.transcribe('file://a.wav', {
        language: 'en',
      });

      expect(mockParakeet.transcribe).toHaveBeenCalledTimes(2);
      expect(mockParakeet.transcribe).toHaveBeenLastCalledWith('file://a.wav', {
        version: 'v2',
        language: 'en',
        wordTimestamps: undefined,
      });
      expect(response.endpoint).toBe('parakeet-v2');
    });

    it('routes later dictations around it', async () => {
      mockParakeet.hasFailedToLoad.mockImplementation((version) => version === 'orukeet');

      await LocalTranscriptionService.transcribe('file://a.wav', {});

      expect(mockParakeet.transcribe).toHaveBeenCalledTimes(1);
      expect(mockParakeet.transcribe).toHaveBeenCalledWith(
        'file://a.wav',
        expect.objectContaining({ version: 'v2' }),
      );
    });

    it('does not reroute a transcription that failed for another reason', async () => {
      mockParakeet.transcribe.mockRejectedValueOnce(new Error('decode failed'));

      await expect(LocalTranscriptionService.transcribe('file://a.wav', {})).rejects.toThrow(
        'decode failed',
      );
      expect(mockParakeet.transcribe).toHaveBeenCalledTimes(1);
    });

    it('prepareForLanguage warms the model it would otherwise use', async () => {
      let failed = false;
      mockParakeet.hasFailedToLoad.mockImplementation(() => failed);
      mockParakeet.prepare.mockImplementationOnce(async () => {
        failed = true;
        throw new Error('Core ML could not load Encoder.mlmodelc');
      });

      await LocalTranscriptionService.prepareForLanguage('en');

      expect(mockParakeet.prepare).toHaveBeenCalledTimes(2);
      expect(mockParakeet.prepare).toHaveBeenLastCalledWith('v2');
    });
  });

  it('routes auto and mixed selections to Whisper, passing prompt + language through', async () => {
    setLanguages([]);
    const response = await LocalTranscriptionService.transcribe('file://a.wav', {
      prompt: 'jargon',
      wordTimestamps: true,
    });
    expect(mockWhisper.transcribe).toHaveBeenCalledWith('file://a.wav', {
      modelName: 'base',
      language: undefined,
      wordTimestamps: true,
      prompt: 'jargon',
    });
    expect(mockParakeet.cleanup).toHaveBeenCalled();
    expect(mockParakeet.transcribe).not.toHaveBeenCalled();
    expect(response.endpoint).toBe('whisper-base');
  });

  it('falls back to Whisper when the preferred Parakeet model is missing', async () => {
    setLanguages(['en']);
    mockParakeet.isModelDownloaded.mockResolvedValue(false);
    const response = await LocalTranscriptionService.transcribe('file://a.wav', {
      language: 'en',
    });
    expect(mockWhisper.transcribe).toHaveBeenCalled();
    expect(response.endpoint).toBe('whisper-base');
  });

  it('throws a downloadable-model error when no engine has a model', async () => {
    setLanguages(['en']);
    mockParakeet.isModelDownloaded.mockResolvedValue(false);
    mockWhisper.getAvailableModels.mockResolvedValue([]);
    await expect(LocalTranscriptionService.transcribe('file://a.wav', {})).rejects.toThrow(
      /not available.*download/i,
    );
  });

  it('does not treat legacy Whisper artifacts as the multilingual base fallback', async () => {
    mockWhisper.getAvailableModels.mockResolvedValue([
      { name: 'base.en', size: 1, downloaded: true },
      { name: 'tiny', size: 1, downloaded: true },
    ]);

    await expect(LocalTranscriptionService.getAvailability()).resolves.toMatchObject({
      whisperDownloaded: false,
    });
  });

  it('prepareForLanguage warms the engine the selection routes to', async () => {
    setLanguages(['en']);
    await LocalTranscriptionService.prepareForLanguage('en');
    expect(mockParakeet.prepare).toHaveBeenCalledWith('v2');
    expect(mockWhisper.prepareForLanguage).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockParakeet.isAvailable.mockReturnValue(true);
    mockParakeet.isModelDownloaded.mockResolvedValue(true);
    mockWhisper.isAvailable.mockReturnValue(true);
    mockWhisper.getAvailableModels.mockResolvedValue([{ name: 'base', size: 1, downloaded: true }]);
    setLanguages(['ja']);
    await LocalTranscriptionService.prepareForLanguage('ja');
    expect(mockWhisper.prepareForLanguage).toHaveBeenCalledWith('ja');
    expect(mockParakeet.prepare).not.toHaveBeenCalled();
  });

  it('prepareForLanguage never downloads: undownloaded Parakeet resolves to Whisper', async () => {
    setLanguages(['en']);
    mockParakeet.isModelDownloaded.mockResolvedValue(false);
    await LocalTranscriptionService.prepareForLanguage('en');
    expect(mockParakeet.prepare).not.toHaveBeenCalled();
    expect(mockWhisper.prepareForLanguage).toHaveBeenCalledWith('en');
  });

  it('isReadyForLanguage reflects whether the routed engine has its model', async () => {
    setLanguages(['en']);
    await expect(LocalTranscriptionService.isReadyForLanguage()).resolves.toBe(true);

    mockParakeet.isModelDownloaded.mockResolvedValue(false);
    mockWhisper.getAvailableModels.mockResolvedValue([]);
    await expect(LocalTranscriptionService.isReadyForLanguage()).resolves.toBe(false);
  });

  it('describes the preferred engine for display', () => {
    setLanguages(['en']);
    expect(LocalTranscriptionService.preferredEngineDescriptor()).toEqual({
      engine: 'parakeet',
      version: 'v2',
      label: 'Parakeet v2',
    });
    setLanguages(['en', 'he']);
    expect(LocalTranscriptionService.preferredEngineDescriptor()).toEqual({
      engine: 'whisper',
      label: 'Whisper base',
    });
  });

  it('cancelTranscription fans out to both engines', async () => {
    await LocalTranscriptionService.cancelTranscription();
    expect(mockWhisper.cancelTranscription).toHaveBeenCalled();
    expect(mockParakeet.cancelTranscription).toHaveBeenCalled();
  });
});
