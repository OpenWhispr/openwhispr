import {
  whisperSegmentsToWords,
  diarizationToTurns,
  speakerLabelFor,
  UNKNOWN_SPEAKER_LABEL,
} from '../diarizationBridge';
import type { DiarizationResult } from '../diarizer';
import type { WhisperSegment } from '@/types';

describe('whisperSegmentsToWords (centiseconds -> ms)', () => {
  it('converts t0/t1 centiseconds to ms (x10) and trims text', () => {
    const segs: WhisperSegment[] = [
      { text: ' hello', t0: 10, t1: 60 }, // 100ms..600ms
      { text: 'there ', t0: 70, t1: 120 }, // 700ms..1200ms
    ];
    expect(whisperSegmentsToWords(segs)).toEqual([
      { text: 'hello', startMs: 100, endMs: 600 },
      { text: 'there', startMs: 700, endMs: 1200 },
    ]);
  });

  it('drops empty / whitespace-only tokens', () => {
    const segs: WhisperSegment[] = [
      { text: 'a', t0: 0, t1: 10 },
      { text: '   ', t0: 10, t1: 20 },
      { text: '', t0: 20, t1: 30 },
      { text: 'b', t0: 30, t1: 40 },
    ];
    expect(whisperSegmentsToWords(segs).map((w) => w.text)).toEqual(['a', 'b']);
  });

  it('returns [] for no segments', () => {
    expect(whisperSegmentsToWords([])).toEqual([]);
  });
});

describe('diarizationToTurns (seconds -> ms, numeric id -> label)', () => {
  it('converts seconds to ms (x1000) and ids to speaker_N', () => {
    const result: DiarizationResult = {
      speakerCount: 2,
      segments: [
        { start: 0, end: 1.5, speakerId: 0 },
        { start: 1.5, end: 3, speakerId: 1 },
      ],
      embeddings: {},
    };
    expect(diarizationToTurns(result)).toEqual([
      { speakerLabel: 'speaker_0', startMs: 0, endMs: 1500 },
      { speakerLabel: 'speaker_1', startMs: 1500, endMs: 3000 },
    ]);
  });

  it('maps a null speakerId to the unknown label', () => {
    const result: DiarizationResult = {
      speakerCount: 1,
      segments: [{ start: 0, end: 1, speakerId: null }],
      embeddings: {},
    };
    expect(diarizationToTurns(result)[0].speakerLabel).toBe(UNKNOWN_SPEAKER_LABEL);
  });
});

describe('speakerLabelFor', () => {
  it('stringifies an id and handles null', () => {
    expect(speakerLabelFor(2)).toBe('speaker_2');
    expect(speakerLabelFor(null)).toBe(UNKNOWN_SPEAKER_LABEL);
  });
});
