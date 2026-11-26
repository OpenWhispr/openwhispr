import { inSpokenOrder, mapUtterancesToSegments } from '../cloudMeetingSegments';
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

  it('saves utterances in the order spoken, not the order their transcriptions finished', () => {
    // At a leg rotation the retired leg's last turn finishes after the new leg's first.
    const segments = mapUtterancesToSegments(
      [
        utterance({ text: 'new leg', startMs: 60_000, endMs: 62_000 }),
        utterance({ text: 'retired leg', startMs: 58_000, endMs: 60_500 }),
        utterance({ text: 'later', startMs: 63_000, endMs: 64_000 }),
      ],
      90,
    );
    expect(segments.map((s) => [s.text, s.startMs, s.sortOrder])).toEqual([
      ['retired leg', 58_000, 0],
      ['new leg', 60_000, 1],
      ['later', 63_000, 2],
    ]);
  });

  it('never places an untimed utterance before the one that finished ahead of it', () => {
    const segments = mapUtterancesToSegments(
      [
        utterance({ text: 'timed late', startMs: 25_000, endMs: 26_000 }),
        utterance({ text: 'b' }),
        utterance({ text: 'timed later', startMs: 28_000, endMs: 29_000 }),
      ],
      30,
    );
    // Its spread position (10 s) would put it ahead of the 25 s utterance it finished after.
    expect(segments.map((s) => [s.text, s.startMs, s.sortOrder])).toEqual([
      ['timed late', 25_000, 0],
      ['b', 26_000, 1],
      ['timed later', 28_000, 2],
    ]);
  });
});

describe('inSpokenOrder', () => {
  it('sorts by start and renumbers, keeping the given order for segments that start together', () => {
    expect(
      inSpokenOrder([
        { id: 'c', startMs: 2000, sortOrder: 0 },
        { id: 'a', startMs: 1000, sortOrder: 1 },
        { id: 'b', startMs: 1000, sortOrder: 2 },
      ]),
    ).toEqual([
      { id: 'a', startMs: 1000, sortOrder: 0 },
      { id: 'b', startMs: 1000, sortOrder: 1 },
      { id: 'c', startMs: 2000, sortOrder: 2 },
    ]);
  });

  it('leaves its input untouched', () => {
    const segments = [
      { startMs: 2000, sortOrder: 0 },
      { startMs: 1000, sortOrder: 1 },
    ];
    inSpokenOrder(segments);
    expect(segments).toEqual([
      { startMs: 2000, sortOrder: 0 },
      { startMs: 1000, sortOrder: 1 },
    ]);
  });
});
