jest.mock('../../../../modules/parakeet-asr/src', () => ({
  ParakeetASR: {
    isModelDownloaded: jest.fn(async () => true),
    prepare: jest.fn(async () => ({ loadMs: 900, modelSizeBytes: 600 })),
    transcribe: jest.fn(async () => ({
      text: 'hello',
      confidence: 0.9,
      rtfx: 50,
      inferMs: 200,
      audioSeconds: 10,
      peakBytes: 700,
      minAvailableBytes: 100,
    })),
    release: jest.fn(async () => undefined),
  },
}));
jest.mock('@/services/transcription/LocalWhisperService', () => ({ LocalWhisperService: {} }));
jest.mock('@/services/transcription/LocalParakeetService', () => ({
  LocalParakeetService: { downloadModel: jest.fn(async () => undefined) },
}));

import { ParakeetASR } from '../../../../modules/parakeet-asr/src';
import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';
import { ENGINE_LABEL, runBenchmark } from '../runParakeetBenchmark';

const mockNative = ParakeetASR as jest.Mocked<typeof ParakeetASR>;
const mockParakeet = LocalParakeetService as jest.Mocked<typeof LocalParakeetService>;

describe('runBenchmark', () => {
  it('measures Orukeet on the Parakeet runtime under its own version', async () => {
    const [result] = await runBenchmark('file://clip.wav', ['orukeet'], { warmRuns: 1 });

    expect(mockNative.prepare).toHaveBeenCalledWith('orukeet');
    expect(mockNative.transcribe).toHaveBeenCalledWith('file://clip.wav', 'orukeet', {
      sampleMemory: true,
    });
    expect(result).toMatchObject({ engine: 'orukeet', label: 'Orukeet r3 (int8)', ok: true });
    expect(ENGINE_LABEL.orukeet).toBe('Orukeet r3 (int8)');
  });

  it("times an archive model's on-device install apart from its download", async () => {
    let now = 1_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockNative.isModelDownloaded.mockResolvedValueOnce(false);
    mockParakeet.downloadModel.mockImplementationOnce(async (_version, _onProgress, onPhase) => {
      now = 4_000; // transfer done
      onPhase?.('verifying');
      now = 4_500;
      onPhase?.('compiling');
      now = 9_000; // install done
    });

    const [result] = await runBenchmark('file://clip.wav', ['orukeet'], { warmRuns: 1 });

    expect(result.installMs).toBe(5_000);
    clock.mockRestore();
  });

  it('reports no install time for a model downloaded straight into place', async () => {
    mockNative.isModelDownloaded.mockResolvedValueOnce(false);

    const [result] = await runBenchmark('file://clip.wav', ['parakeet-v3'], { warmRuns: 1 });

    expect(mockParakeet.downloadModel).toHaveBeenCalledWith('v3', undefined, expect.any(Function));
    expect(result.installMs).toBeUndefined();
  });
});
