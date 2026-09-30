import { mapUtterancesToSegments } from '../cloudMeetingSegments';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';

const utterance = (over: Partial<RealtimeUtterance>): RealtimeUtterance => ({
  itemId: 'item',
  text: 'hello',
  startMs: null,
  endMs: null,
  ...over,
});

describe('mapUtterancesToSegments', () => {
  it('uses present timings, trims text, nulls speaker, and orders by index', () => {
    const segments = mapUtterancesToSegments(
      [
        utterance({ text: '  first  ', startMs: 100, endMs: 900 }),
        utterance({ text: 'second', startMs: 1000, endMs: 1800 }),
      ],
      30,
    );
    expect(segments).toEqual([
      { text: 'first', startMs: 100, endMs: 900, speakerLabel: null, sortOrder: 0 },
      { text: 'second', startMs: 1000, endMs: 1800, speakerLabel: null, sortOrder: 1 },
    ]);
  });

  it('falls back to elapsed-derived timings when the utterance timings are null', () => {
    const segments = mapUtterancesToSegments(
      [utterance({ text: 'a' }), utterance({ text: 'b' }), utterance({ text: 'c' })],
      30,
    );
    // 30s / 3 utterances → 10s buckets, non-null and monotonic.
    expect(segments.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 10000],
      [10000, 20000],
      [20000, 30000],
    ]);
    expect(segments.every((s) => s.speakerLabel === null)).toBe(true);
  });

  it('clamps endMs to be at least startMs', () => {
    const [segment] = mapUtterancesToSegments([utterance({ startMs: 5000, endMs: 1000 })], 30);
    expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs);
  });

  it('returns an empty array for no utterances', () => {
    expect(mapUtterancesToSegments([], 30)).toEqual([]);
  });
});
