jest.mock('../../../../modules/parakeet-asr/src', () => ({
  ParakeetASR: {
    isAvailable: jest.fn(() => true),
    isModelDownloaded: jest.fn(async () => true),
    deleteModel: jest.fn(async () => undefined),
    modelSizeBytes: jest.fn(async () => 0),
    prepare: jest.fn(async () => ({ loadMs: 5, modelSizeBytes: 1 })),
    transcribe: jest.fn(),
    release: jest.fn(async () => undefined),
  },
}));

jest.mock('../parakeetModelDownloader', () => ({
  downloadParakeetModel: jest.fn(async () => undefined),
  cancelParakeetDownload: jest.fn(async () => undefined),
  stagedParakeetBytes: jest.fn(async () => 0),
}));

import { ParakeetASR } from '../../../../modules/parakeet-asr/src';
import { LocalParakeetService } from '../LocalParakeetService';
import {
  cancelParakeetDownload,
  downloadParakeetModel,
  stagedParakeetBytes,
} from '../parakeetModelDownloader';

const mockNative = ParakeetASR as jest.Mocked<typeof ParakeetASR>;
const mockDownloadParakeetModel = downloadParakeetModel as jest.MockedFunction<
  typeof downloadParakeetModel
>;
const mockCancelParakeetDownload = cancelParakeetDownload as jest.MockedFunction<
  typeof cancelParakeetDownload
>;
const mockStagedParakeetBytes = stagedParakeetBytes as jest.MockedFunction<
  typeof stagedParakeetBytes
>;

// Mirror of isLocalModelMissingError (TranscriptionService.ts) — asserted inline because pulling
// TranscriptionService into jest drags the native upload/audio bridges with it.
const LOCAL_MODEL_MISSING_PATTERN = /not available|model path not found|please download/i;

describe('LocalParakeetService.transcribe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.isAvailable.mockReturnValue(true);
    mockNative.isModelDownloaded.mockResolvedValue(true);
    mockNative.prepare.mockResolvedValue({ loadMs: 5, modelSizeBytes: 1 });
    mockNative.transcribe.mockResolvedValue({
      text: '  hello world  ',
      confidence: 0.95,
      rtfx: 100,
      inferMs: 150,
      audioSeconds: 12.5,
    });
  });

  afterEach(async () => {
    await LocalParakeetService.cleanup();
  });

  it('maps the native result to a TranscriptionResponse', async () => {
    const response = await LocalParakeetService.transcribe('file://a.wav', { version: 'v2' });
    expect(response.text).toBe('hello world');
    expect(response.provider).toBe('local');
    expect(response.duration).toBe(12.5);
    expect(typeof response.processingMs).toBe('number');
    expect(response.segments).toBeUndefined();
  });

  it('prepares the requested version before transcribing, once per version', async () => {
    await LocalParakeetService.transcribe('file://a.wav', { version: 'v2' });
    await LocalParakeetService.transcribe('file://b.wav', { version: 'v2' });
    expect(mockNative.prepare).toHaveBeenCalledTimes(1);
    expect(mockNative.prepare).toHaveBeenCalledWith('v2');

    await LocalParakeetService.transcribe('file://c.wav', { version: 'v3' });
    expect(mockNative.prepare).toHaveBeenCalledTimes(2);
    expect(mockNative.prepare).toHaveBeenLastCalledWith('v3');
  });

  it('passes the language hint through and requests token timings for word timestamps', async () => {
    mockNative.transcribe.mockResolvedValue({
      text: 'hallo',
      confidence: 0.9,
      rtfx: 90,
      inferMs: 100,
      audioSeconds: 3,
      tokenTimings: [{ token: '▁hallo', startTime: 0.5, endTime: 0.9, confidence: 0.8 }],
    });
    const response = await LocalParakeetService.transcribe('file://a.wav', {
      version: 'v3',
      language: 'de',
      wordTimestamps: true,
    });
    expect(mockNative.transcribe).toHaveBeenCalledWith('file://a.wav', 'v3', {
      language: 'de',
      tokenTimings: true,
    });
    expect(response.segments).toEqual([{ text: 'hallo', t0: 50, t1: 90 }]);
  });

  it('throws a missing-model error that isLocalModelMissingError recognizes', async () => {
    mockNative.isModelDownloaded.mockResolvedValue(false);
    const attempt = LocalParakeetService.transcribe('file://a.wav', { version: 'v2' });
    await expect(attempt).rejects.toThrow(/Parakeet v2/);
    await attempt.catch((error: Error) => {
      expect(error.message).toMatch(LOCAL_MODEL_MISSING_PATTERN);
    });
  });

  it('re-prepares after cancelTranscription released the engine', async () => {
    await LocalParakeetService.transcribe('file://a.wav', { version: 'v2' });
    await LocalParakeetService.cancelTranscription();
    expect(mockNative.release).toHaveBeenCalledTimes(1);

    await LocalParakeetService.transcribe('file://b.wav', { version: 'v2' });
    expect(mockNative.prepare).toHaveBeenCalledTimes(2);
  });

  it('releases before deleting the currently-loaded version', async () => {
    await LocalParakeetService.transcribe('file://a.wav', { version: 'v2' });
    await LocalParakeetService.deleteModel('v2');
    expect(mockNative.release).toHaveBeenCalledTimes(1);
    expect(mockNative.deleteModel).toHaveBeenCalledWith('v2');
  });

  it("downloads through the background downloader with the caller's callback", async () => {
    const onProgress = jest.fn();
    await LocalParakeetService.downloadModel('v3', onProgress);

    expect(mockDownloadParakeetModel).toHaveBeenCalledWith('v3', { onProgress });
  });

  it('forwards model-download cancellation to the downloader', async () => {
    await LocalParakeetService.cancelModelDownload('v3');
    expect(mockCancelParakeetDownload).toHaveBeenCalledWith('v3');
  });

  it('reports the staged partial-download size through the downloader', async () => {
    mockStagedParakeetBytes.mockResolvedValue(445);
    await expect(LocalParakeetService.stagedDownloadBytes('v2')).resolves.toBe(445);
    expect(mockStagedParakeetBytes).toHaveBeenCalledWith('v2');
  });
});
