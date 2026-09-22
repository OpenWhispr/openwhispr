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
import { ENGINE_LABEL, runBenchmark } from '../runParakeetBenchmark';

const mockNative = ParakeetASR as jest.Mocked<typeof ParakeetASR>;

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
});
