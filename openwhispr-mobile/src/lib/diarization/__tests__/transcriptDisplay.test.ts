import type { Segment, Speaker } from '@/data/types';
import {
  formatTranscriptForExport,
  formatTranscriptTimestamp,
  getSpeakerDisplayColor,
  getSpeakerDisplayName,
  groupTranscriptSegments,
} from '../transcriptDisplay';

const speaker = (overrides: Partial<Speaker>): Speaker =>
  ({
    id: 1,
    noteId: 7,
    speakerLabel: 'SPEAKER_00',
    displayName: null,
    profileId: null,
    color: null,
    sortOrder: 0,
    speakerStatus: 'provisional',
    speakerLocked: 0,
    speakerLockSource: null,
    clientId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Speaker;

const segment = (overrides: Partial<Segment>): Segment =>
  ({
    id: 1,
    noteId: 7,
    startMs: 0,
    endMs: 1000,
    text: '',
    speakerLabel: null,
    sortOrder: 0,
    clientId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Segment;

describe('transcriptDisplay', () => {
  it('formats stable timestamps', () => {
    expect(formatTranscriptTimestamp(3_450)).toBe('0:03');
    expect(formatTranscriptTimestamp(3_724_000)).toBe('1:02:04');
  });

  it('falls back from displayName to Speaker N', () => {
    expect(getSpeakerDisplayName(speaker({ displayName: ' Alice ', sortOrder: 4 }), 0)).toBe(
      'Alice',
    );
    expect(getSpeakerDisplayName(speaker({ displayName: null, sortOrder: 1 }), 0)).toBe(
      'Speaker 2',
    );
  });

  it('marks suggested speaker names as tentative', () => {
    expect(
      getSpeakerDisplayName(
        speaker({ displayName: 'Alice', speakerStatus: 'suggested', sortOrder: 0 }),
        0,
      ),
    ).toBe('Alice?');
  });

  it('sorts and groups adjacent segments by speaker', () => {
    const blocks = groupTranscriptSegments(
      [
        segment({
          id: 3,
          speakerLabel: 'SPEAKER_01',
          startMs: 2_000,
          endMs: 3_000,
          text: 'Reply',
          sortOrder: 2,
        }),
        segment({
          id: 1,
          speakerLabel: 'SPEAKER_00',
          startMs: 0,
          endMs: 900,
          text: 'Hello',
          sortOrder: 0,
        }),
        segment({
          id: 2,
          speakerLabel: 'SPEAKER_00',
          startMs: 950,
          endMs: 1_500,
          text: '  world ',
          sortOrder: 1,
        }),
      ],
      [
        speaker({ id: 10, speakerLabel: 'SPEAKER_00', displayName: 'Alice', sortOrder: 0 }),
        speaker({ id: 11, speakerLabel: 'SPEAKER_01', displayName: 'Bob', sortOrder: 1 }),
      ],
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(
      expect.objectContaining({
        speakerId: 10,
        speakerName: 'Alice',
        timestamp: '0:00',
        text: 'Hello world',
        segmentIds: [1, 2],
      }),
    );
    expect(blocks[1]).toEqual(
      expect.objectContaining({ speakerName: 'Bob', timestamp: '0:02', text: 'Reply' }),
    );
  });

  it('uses stored speaker color and deterministic fallback colors', () => {
    const stored = speaker({ color: '#123456', sortOrder: 2 });
    const fallback = speaker({ color: null, sortOrder: 2 });

    expect(getSpeakerDisplayColor(stored, 0)).toBe('#123456');
    expect(getSpeakerDisplayColor(fallback, 0)).toBe(getSpeakerDisplayColor(fallback, 99));
    expect(getSpeakerDisplayColor(fallback, 0)).not.toBe('#8E8E93');
  });

  it('exports title, speaker names, timestamps, and text in order', () => {
    const text = formatTranscriptForExport({
      title: 'Weekly Review',
      segments: [
        segment({
          id: 2,
          speakerLabel: 'SPEAKER_01',
          startMs: 62_000,
          endMs: 64_000,
          text: 'Looks good.',
          sortOrder: 1,
        }),
        segment({
          id: 1,
          speakerLabel: 'SPEAKER_00',
          startMs: 3_000,
          endMs: 4_000,
          text: 'Ship it.',
          sortOrder: 0,
        }),
      ],
      speakers: [
        speaker({ id: 10, speakerLabel: 'SPEAKER_00', displayName: 'Alice', sortOrder: 0 }),
        speaker({ id: 11, speakerLabel: 'SPEAKER_01', displayName: null, sortOrder: 1 }),
      ],
    });

    expect(text).toBe('Weekly Review\n\n[0:03] Alice: Ship it.\n\n[1:02] Speaker 2: Looks good.');
  });

  it('suppresses only unlabeled speaker names for meeting-note generation', () => {
    const segments = [
      segment({
        id: 1,
        startMs: 0,
        endMs: 1000,
        text: 'Ship the onboarding fix.',
        speakerLabel: null,
        sortOrder: 0,
      }),
      segment({
        id: 2,
        startMs: 2000,
        endMs: 3000,
        text: 'I will review it.',
        speakerLabel: 'SPEAKER_00',
        sortOrder: 1,
      }),
      segment({
        id: 3,
        startMs: 4000,
        endMs: 5000,
        text: 'I will publish it.',
        speakerLabel: 'SPEAKER_01',
        sortOrder: 2,
      }),
    ];
    const speakers = [
      speaker({ id: 10, speakerLabel: 'SPEAKER_00', displayName: 'Alice', sortOrder: 0 }),
      speaker({ id: 11, speakerLabel: 'SPEAKER_01', displayName: null, sortOrder: 1 }),
    ];

    expect(formatTranscriptForExport({ segments, speakers })).toContain(
      '[0:00] Unknown speaker: Ship the onboarding fix.',
    );
    expect(
      formatTranscriptForExport({
        segments,
        speakers,
        suppressUnlabeledSpeakerNames: true,
      }),
    ).toBe(
      '[0:00] Ship the onboarding fix.\n\n' +
        '[0:02] Alice: I will review it.\n\n' +
        '[0:04] Speaker 2: I will publish it.',
    );
  });
});
