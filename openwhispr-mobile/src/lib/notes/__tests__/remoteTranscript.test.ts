import type { Segment, Speaker } from '@/data/types';
import {
  MIC_SPEAKER_LABEL,
  parseRemoteTranscript,
  serializeSegmentsForSync,
} from '../remoteTranscript';

// A realistic desktop-serialized transcript (shape from
// openwhispr/src/utils/transcriptSpeakerState.ts serializeTranscriptSegments).
const desktopRaw = JSON.stringify([
  {
    text: 'Hello everyone.',
    source: 'mic',
    timestamp: 1_000_000,
  },
  {
    text: 'Hi, glad to be here.',
    source: 'system',
    timestamp: 1_000_500,
    speaker: 'speaker_0',
    speakerName: 'Alice',
    speakerStatus: 'confirmed',
    speakerLocked: true,
    speakerLockSource: 'user',
  },
  {
    text: 'Same, thanks for setting this up.',
    source: 'system',
    timestamp: 1_002_000,
    speaker: 'speaker_1',
    speakerName: 'Speaker 2',
    speakerIsPlaceholder: true,
    speakerStatus: 'provisional',
  },
  {
    text: "Let's get started.",
    source: 'mic',
    timestamp: 1_003_000,
  },
]);

describe('parseRemoteTranscript', () => {
  it('returns null for malformed / non-array / empty input', () => {
    expect(parseRemoteTranscript('')).toBeNull();
    expect(parseRemoteTranscript('not json')).toBeNull();
    expect(parseRemoteTranscript('{"foo":1}')).toBeNull();
    expect(parseRemoteTranscript('[unclosed')).toBeNull();
  });

  it('returns null (never throws) for arrays with non-object members', () => {
    expect(parseRemoteTranscript('[null]')).toBeNull();
    expect(parseRemoteTranscript('[1]')).toBeNull();
    expect(parseRemoteTranscript('["oops"]')).toBeNull();
    expect(parseRemoteTranscript(JSON.stringify([{ text: 'ok', source: 'mic' }, null]))).toBeNull();
  });

  it('parses an empty array to empty segments/speakers', () => {
    expect(parseRemoteTranscript('[]')).toEqual({ segments: [], speakers: [] });
  });

  it('decomposes segments and dedupes speakers in first-seen order', () => {
    const result = parseRemoteTranscript(desktopRaw);
    expect(result).not.toBeNull();
    const { segments, speakers } = result!;

    expect(segments).toHaveLength(4);
    // Two named speakers + the synthetic mic author = 3.
    expect(speakers).toHaveLength(3);

    // mic author is synthesized first (first segment is mic with no speaker).
    expect(speakers[0]).toMatchObject({
      speakerLabel: MIC_SPEAKER_LABEL,
      displayName: 'You',
      sortOrder: 0,
    });
    expect(speakers[1]).toMatchObject({
      speakerLabel: 'speaker_0',
      displayName: 'Alice',
      speakerStatus: 'confirmed',
      speakerLocked: 1,
      speakerLockSource: 'user',
      sortOrder: 1,
    });
    expect(speakers[2]).toMatchObject({
      speakerLabel: 'speaker_1',
      displayName: 'Speaker 2',
      speakerStatus: 'provisional',
      speakerLocked: 0,
      sortOrder: 2,
    });
  });

  it('maps segment fields and derives offsets relative to the earliest timestamp', () => {
    const { segments } = parseRemoteTranscript(desktopRaw)!;
    expect(segments[0]).toMatchObject({
      text: 'Hello everyone.',
      speakerLabel: MIC_SPEAKER_LABEL,
      startMs: 0,
      sortOrder: 0,
    });
    // second segment is 500ms after the first
    expect(segments[1]).toMatchObject({ speakerLabel: 'speaker_0', startMs: 500 });
    expect(segments[2]).toMatchObject({ speakerLabel: 'speaker_1', startMs: 2000 });
    expect(segments[3]).toMatchObject({ speakerLabel: MIC_SPEAKER_LABEL, startMs: 3000 });
    // endMs of each is the next segment's start (clamped), last collapses to its own start.
    expect(segments[0].endMs).toBe(500);
    expect(segments[2].endMs).toBe(3000);
    expect(segments[3].endMs).toBe(3000);
  });

  it('falls back to monotonic offsets when timestamps are missing', () => {
    const raw = JSON.stringify([
      { text: 'a', source: 'mic', speaker: 'speaker_0' },
      { text: 'b', source: 'mic', speaker: 'speaker_0' },
    ]);
    const { segments } = parseRemoteTranscript(raw)!;
    expect(segments.map((s) => s.startMs)).toEqual([0, 0]);
    expect(segments.every((s) => Number.isInteger(s.startMs) && s.startMs >= 0)).toBe(true);
  });
});

describe('serializeSegmentsForSync', () => {
  const seg = (over: Partial<Segment>): Segment =>
    ({
      id: 1,
      noteId: 1,
      startMs: 0,
      endMs: 0,
      text: '',
      speakerLabel: null,
      sortOrder: 0,
      clientId: null,
      remoteId: null,
      deletedAt: null,
      pendingSync: 0,
      createdAt: null,
      updatedAt: null,
      ...over,
    }) as Segment;

  const speaker = (over: Partial<Speaker>): Speaker =>
    ({
      id: 1,
      noteId: 1,
      speakerLabel: 'speaker_0',
      displayName: null,
      profileId: null,
      color: null,
      sortOrder: 0,
      speakerStatus: null,
      speakerLocked: 0,
      speakerLockSource: null,
      clientId: null,
      remoteId: null,
      deletedAt: null,
      pendingSync: 0,
      createdAt: null,
      updatedAt: null,
      ...over,
    }) as Speaker;

  it('emits desktop-shape objects with mic/system sources, ordered by sortOrder', () => {
    const segments = [
      seg({ id: 2, sortOrder: 1, text: 'second', speakerLabel: 'speaker_0' }),
      seg({ id: 1, sortOrder: 0, text: 'first', speakerLabel: MIC_SPEAKER_LABEL }),
    ];
    const speakers = [speaker({ speakerLabel: 'speaker_0', displayName: 'Alice' })];

    const parsed = JSON.parse(serializeSegmentsForSync(segments, speakers));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ text: 'first', source: 'mic' });
    expect(parsed[1]).toEqual({
      text: 'second',
      source: 'system',
      speaker: 'speaker_0',
      speakerName: 'Alice',
    });
    expect(parsed.every((p: Record<string, unknown>) => !('timestamp' in p))).toBe(true);
  });

  it('round-trips speaker identity through parse(serialize(x))', () => {
    const segments = [
      seg({ id: 1, sortOrder: 0, text: 'hi', speakerLabel: 'speaker_0' }),
      seg({ id: 2, sortOrder: 1, text: 'there', speakerLabel: 'speaker_1' }),
    ];
    const speakers = [
      speaker({ speakerLabel: 'speaker_0', displayName: 'Alice', speakerStatus: 'confirmed' }),
      speaker({ speakerLabel: 'speaker_1', displayName: 'Bob', speakerStatus: 'suggested' }),
    ];

    const reparsed = parseRemoteTranscript(serializeSegmentsForSync(segments, speakers))!;
    expect(reparsed.segments.map((s) => ({ text: s.text, speakerLabel: s.speakerLabel }))).toEqual([
      { text: 'hi', speakerLabel: 'speaker_0' },
      { text: 'there', speakerLabel: 'speaker_1' },
    ]);
    expect(
      reparsed.speakers.map((s) => ({
        label: s.speakerLabel,
        name: s.displayName,
        status: s.speakerStatus,
      })),
    ).toEqual([
      { label: 'speaker_0', name: 'Alice', status: 'confirmed' },
      { label: 'speaker_1', name: 'Bob', status: 'suggested' },
    ]);
  });
});

describe('desktop metadata preservation', () => {
  function roundTrip(raw: string, rename = false): unknown {
    const parsed = parseRemoteTranscript(raw)!;
    const segments = parsed.segments.map((segment, id) => ({
      ...segment,
      id,
      noteId: 1,
    })) as Segment[];
    const speakers = parsed.speakers.map((speaker, id) => ({
      ...speaker,
      id,
      noteId: 1,
      ...(rename && speaker.speakerLabel === 'speaker_0' ? { displayName: 'Renamed' } : {}),
    })) as Speaker[];
    return JSON.parse(serializeSegmentsForSync(segments, speakers, raw));
  }

  it('preserves the complete desktop wire format without edits', () => {
    const entries = JSON.parse(desktopRaw);
    entries[1].suggestedName = 'Candidate';
    entries[1].futureMetadata = { confidence: 0.91 };
    entries.push({
      text: 'another line',
      source: 'mic',
      timestamp: 1004000,
      speaker: 'speaker_0',
      speakerName: 'Per-line name',
      speakerLocked: false,
    });
    expect(roundTrip(JSON.stringify(entries))).toEqual(entries);
  });

  it('changes a speaker name without discarding timestamps, source or unknown fields', () => {
    const entries = JSON.parse(desktopRaw);
    const expected = JSON.parse(desktopRaw);
    expected[1].speakerName = 'Renamed';
    expect(roundTrip(JSON.stringify(entries), true)).toEqual(expected);
  });
});
