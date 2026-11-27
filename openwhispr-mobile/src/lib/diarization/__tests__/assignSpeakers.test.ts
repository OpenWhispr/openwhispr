import { assignSpeakersToSegments } from '../assignSpeakers';
import { UNKNOWN_SPEAKER_LABEL } from '../diarizationBridge';

const turns = [
  { speakerLabel: 'speaker_0', startMs: 0, endMs: 5000 },
  { speakerLabel: 'speaker_1', startMs: 5000, endMs: 9000 },
];

describe('assignSpeakersToSegments', () => {
  it('labels each segment with the turn it overlaps most', () => {
    expect(
      assignSpeakersToSegments(
        [
          { startMs: 1000, endMs: 4000 },
          { startMs: 4500, endMs: 8000 },
          { startMs: 20_000, endMs: 21_000 },
        ],
        turns,
      ).map((s) => s.speakerLabel),
    ).toEqual(['speaker_0', 'speaker_1', null]);
  });

  it('keeps text, timing and other fields untouched', () => {
    const [labelled] = assignSpeakersToSegments(
      [{ text: 'Hello.', startMs: 1000, endMs: 4000, sortOrder: 3, speakerLabel: null }],
      turns,
    );
    expect(labelled).toEqual({
      text: 'Hello.',
      startMs: 1000,
      endMs: 4000,
      sortOrder: 3,
      speakerLabel: 'speaker_0',
    });
  });

  it('leaves a long stretch unlabelled when no speaker covers more than half of it', () => {
    // A two-minute backfilled block with three speakers in it.
    const block = { startMs: 0, endMs: 120_000, speakerLabel: null };
    const threeSpeakers = [
      { speakerLabel: 'speaker_0', startMs: 0, endMs: 50_000 },
      { speakerLabel: 'speaker_1', startMs: 50_000, endMs: 90_000 },
      { speakerLabel: 'speaker_2', startMs: 90_000, endMs: 120_000 },
    ];
    expect(assignSpeakersToSegments([block], threeSpeakers)[0].speakerLabel).toBeNull();
  });

  it('labels a long stretch one speaker holds for most of it', () => {
    const block = { startMs: 0, endMs: 120_000 };
    const mostlyOne = [
      { speakerLabel: 'speaker_0', startMs: 0, endMs: 40_000 },
      { speakerLabel: 'speaker_1', startMs: 40_000, endMs: 50_000 },
      { speakerLabel: 'speaker_0', startMs: 50_000, endMs: 120_000 },
    ];
    expect(assignSpeakersToSegments([block], mostlyOne)[0].speakerLabel).toBe('speaker_0');
  });

  it('clears a stale label when no turn overlaps', () => {
    expect(
      assignSpeakersToSegments(
        [{ startMs: 30_000, endMs: 31_000, speakerLabel: 'speaker_4' }],
        turns,
      )[0].speakerLabel,
    ).toBeNull();
  });

  it('leaves zero-length and inverted segments unlabelled', () => {
    expect(
      assignSpeakersToSegments(
        [
          { startMs: 2000, endMs: 2000 },
          { startMs: 4000, endMs: 1000 },
        ],
        turns,
      ).map((s) => s.speakerLabel),
    ).toEqual([null, null]);
  });

  it('never assigns the label of a turn the engine could not attribute', () => {
    expect(
      assignSpeakersToSegments(
        [{ startMs: 0, endMs: 1000 }],
        [{ speakerLabel: UNKNOWN_SPEAKER_LABEL, startMs: 0, endMs: 1000 }],
      )[0].speakerLabel,
    ).toBeNull();
  });
});
