import { mergeWordsWithSpeakers, type Word, type SpeakerTurn } from '../mergeSegments';

const turns: SpeakerTurn[] = [
  { speakerLabel: 'A', startMs: 0, endMs: 2000 },
  { speakerLabel: 'B', startMs: 2000, endMs: 4000 },
];

describe('mergeWordsWithSpeakers', () => {
  it('returns [] for no words', () => {
    expect(mergeWordsWithSpeakers([], turns)).toEqual([]);
  });

  it('groups consecutive same-speaker words into one segment per turn', () => {
    const words: Word[] = [
      { text: 'hello', startMs: 100, endMs: 600 },
      { text: 'there', startMs: 700, endMs: 1200 },
      { text: 'hi', startMs: 2100, endMs: 2600 },
    ];
    const out = mergeWordsWithSpeakers(words, turns);
    expect(out).toEqual([
      { text: 'hello there', startMs: 100, endMs: 1200, speakerLabel: 'A' },
      { text: 'hi', startMs: 2100, endMs: 2600, speakerLabel: 'B' },
    ]);
  });

  it('assigns each word to the max-overlap turn', () => {
    // word straddles the A/B boundary but mostly overlaps B
    const words: Word[] = [{ text: 'word', startMs: 1900, endMs: 2400 }];
    const out = mergeWordsWithSpeakers(words, turns);
    expect(out[0].speakerLabel).toBe('B');
  });

  it('falls back to the previous label when a word overlaps no turn', () => {
    const words: Word[] = [
      { text: 'a', startMs: 100, endMs: 600 },
      { text: 'b', startMs: 5000, endMs: 5500 }, // past all turns
    ];
    const out = mergeWordsWithSpeakers(words, turns);
    expect(out).toHaveLength(1);
    expect(out[0].speakerLabel).toBe('A');
  });

  it('fully converges with >10 consecutive blips (would stall under old cap=10)', () => {
    // One long leading A segment followed by 12 alternating B/A/B/A… blips of ~100ms each.
    // All blips are < 500ms, so with minSegmentMs=500 they must all be absorbed into A.
    const blipCount = 12;
    const blipMs = 100;
    const leadEnd = 2000;

    const testTurns: SpeakerTurn[] = [{ speakerLabel: 'A', startMs: 0, endMs: leadEnd }];
    for (let i = 0; i < blipCount; i++) {
      const start = leadEnd + i * blipMs;
      testTurns.push({
        speakerLabel: i % 2 === 0 ? 'B' : 'A',
        startMs: start,
        endMs: start + blipMs,
      });
    }

    const testWords: Word[] = [{ text: 'lead', startMs: 100, endMs: leadEnd }];
    for (let i = 0; i < blipCount; i++) {
      const start = leadEnd + i * blipMs;
      testWords.push({ text: `blip${i}`, startMs: start, endMs: start + blipMs });
    }

    const out = mergeWordsWithSpeakers(testWords, testTurns, { minSegmentMs: 500 });
    const lastWord = testWords[testWords.length - 1];

    expect(out).toHaveLength(1);
    expect(out[0].speakerLabel).toBe('A');
    expect(out[0].startMs).toBe(100);
    expect(out[0].endMs).toBe(lastWord.endMs);
  });

  it('absorbs a short blip into the surrounding speaker (no phantom segment)', () => {
    // B "blip" of 200ms surrounded by A on both sides → should stay one A segment
    const blipTurns: SpeakerTurn[] = [
      { speakerLabel: 'A', startMs: 0, endMs: 1000 },
      { speakerLabel: 'B', startMs: 1000, endMs: 1200 },
      { speakerLabel: 'A', startMs: 1200, endMs: 3000 },
    ];
    const words: Word[] = [
      { text: 'I', startMs: 100, endMs: 400 },
      { text: 'yeah', startMs: 1000, endMs: 1180 },
      { text: 'think', startMs: 1300, endMs: 1700 },
      { text: 'so', startMs: 1800, endMs: 2100 },
    ];
    const out = mergeWordsWithSpeakers(words, blipTurns, { minSegmentMs: 1500 });
    expect(out).toEqual([
      { text: 'I yeah think so', startMs: 100, endMs: 2100, speakerLabel: 'A' },
    ]);
  });
});
