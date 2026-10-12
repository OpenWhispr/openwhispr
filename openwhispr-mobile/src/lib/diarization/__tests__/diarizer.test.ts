import type { DiarSegment, DiarizationResult, Diarizer } from '../diarizer';
import { TRANSCRIPTION_STATUSES, isTranscriptionStatus } from '../diarizer';

describe('diarizer interface + status', () => {
  it('DiarizationResult shape is assignable (seconds + numeric/null speakerId)', () => {
    const seg: DiarSegment = { start: 0, end: 1.5, speakerId: 0 };
    const result: DiarizationResult = {
      speakerCount: 1,
      segments: [seg],
      embeddings: { 0: [0.1, 0.2] },
    };
    expect(result.segments[0].end).toBe(1.5);
    expect(result.segments[0].speakerId).toBe(0);
  });

  it('a Diarizer is satisfied by an object with isAvailable + model methods + diarize', async () => {
    const fake: Diarizer = {
      isAvailable: () => true,
      isModelDownloaded: async () => true,
      downloadModel: async () => undefined,
      deleteModel: async () => undefined,
      diarize: async () => ({ speakerCount: 0, segments: [], embeddings: {} }),
    };
    expect(fake.isAvailable()).toBe(true);
    await expect(fake.isModelDownloaded()).resolves.toBe(true);
    await expect(fake.diarize('file://x.wav', 2)).resolves.toEqual({
      speakerCount: 0,
      segments: [],
      embeddings: {},
    });
  });

  it('isTranscriptionStatus guards the union', () => {
    expect(TRANSCRIPTION_STATUSES).toContain('diarizing');
    expect(isTranscriptionStatus('done')).toBe(true);
    expect(isTranscriptionStatus('bogus')).toBe(false);
  });
});
