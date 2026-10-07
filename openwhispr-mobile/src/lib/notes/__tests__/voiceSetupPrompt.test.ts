import type { Segment, Speaker } from '@/data/types';
import {
  formatSpeakingTime,
  shouldOfferVoiceSetup,
  voiceSetupCandidates,
} from '../voiceSetupPrompt';

const speaker = (overrides: Partial<Speaker> = {}): Speaker =>
  ({
    id: 10,
    noteId: 7,
    speakerLabel: 'speaker_0',
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

const segment = (overrides: Partial<Segment> = {}): Segment =>
  ({
    id: 1,
    noteId: 7,
    startMs: 0,
    endMs: 6000,
    text: 'Hello there.',
    speakerLabel: 'speaker_0',
    sortOrder: 0,
    clientId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Segment;

const offer = (overrides: Partial<Parameters<typeof shouldOfferVoiceSetup>[0]> = {}) =>
  shouldOfferVoiceSetup({
    isOnDeviceMeeting: true,
    transcriptStatus: 'done',
    hasOwnerProfile: false,
    dismissed: false,
    candidateCount: 1,
    ...overrides,
  });

describe('shouldOfferVoiceSetup', () => {
  it('offers setup on a finished on-device meeting with a speaker you can claim', () => {
    expect(offer()).toBe(true);
  });

  it('never offers it for a meeting not recorded on this device', () => {
    expect(offer({ isOnDeviceMeeting: false })).toBe(false);
  });

  it('waits until the transcript is done', () => {
    expect(offer({ transcriptStatus: 'diarizing' })).toBe(false);
  });

  it('stops once you have a voice profile or dismissed the banner', () => {
    expect(offer({ hasOwnerProfile: true })).toBe(false);
    expect(offer({ dismissed: true })).toBe(false);
  });

  it('stays hidden when no speaker can be claimed, such as after a restart', () => {
    expect(offer({ candidateCount: 0 })).toBe(false);
  });
});

describe('voiceSetupCandidates', () => {
  const speakers = [
    speaker({ id: 10, speakerLabel: 'speaker_0', sortOrder: 0 }),
    speaker({ id: 11, speakerLabel: 'speaker_1', sortOrder: 1 }),
  ];
  const segments = [
    segment({ id: 1, speakerLabel: 'speaker_0', startMs: 0, endMs: 6000, text: 'Short.' }),
    segment({
      id: 2,
      speakerLabel: 'speaker_0',
      startMs: 6000,
      endMs: 12000,
      text: 'The longest thing I said today.',
    }),
    segment({
      id: 3,
      speakerLabel: 'speaker_1',
      startMs: 12000,
      endMs: 40000,
      text: 'I talked for a long while.',
    }),
  ];
  const embeddingsByLabel = { speaker_0: [0.1, 0.2], speaker_1: [0.3, 0.4] };
  const profileIds = new Set<number>([4]);
  const candidates = (
    overrides: Partial<Parameters<typeof voiceSetupCandidates>[0]> = {},
  ): ReturnType<typeof voiceSetupCandidates> =>
    voiceSetupCandidates({ segments, speakers, embeddingsByLabel, profileIds, ...overrides });

  it('lists speakers with 10 s of speech and a sample, longest speaker first', () => {
    expect(candidates()).toEqual([
      {
        speakerId: 11,
        name: 'Speaker 2',
        speechMs: 28000,
        sampleLine: 'I talked for a long while.',
      },
      {
        speakerId: 10,
        name: 'Speaker 1',
        speechMs: 12000,
        sampleLine: 'The longest thing I said today.',
      },
    ]);
  });

  it('leaves out speakers under 10 s of speech', () => {
    const short = [segment({ speakerLabel: 'speaker_0', startMs: 0, endMs: 9999 })];
    expect(candidates({ segments: short })).toEqual([]);
  });

  it('includes a speaker with exactly 10 s of speech', () => {
    const enough = [segment({ speakerLabel: 'speaker_0', startMs: 0, endMs: 10_000 })];
    expect(candidates({ segments: enough }).map((candidate) => candidate.speakerId)).toEqual([10]);
  });

  it('leaves out speakers without a sample from this meeting', () => {
    expect(candidates({ embeddingsByLabel: { speaker_1: [] } })).toEqual([]);
    expect(candidates({ embeddingsByLabel: undefined })).toEqual([]);
  });

  it('leaves out speakers already linked to a voice profile', () => {
    const linked = [speaker({ id: 11, speakerLabel: 'speaker_1', profileId: 4 })];
    expect(candidates({ speakers: linked })).toEqual([]);
  });

  it('lists a speaker whose voice profile was deleted, so it can be claimed again', () => {
    const orphaned = [
      speaker({ id: 11, speakerLabel: 'speaker_1', sortOrder: 1, displayName: 'Me', profileId: 9 }),
    ];
    expect(candidates({ speakers: orphaned }).map((candidate) => candidate.speakerId)).toEqual([
      11,
    ]);
  });

  it('lists a speaker you already named, by that name', () => {
    const named = [speaker({ id: 11, speakerLabel: 'speaker_1', displayName: 'Chad' })];
    expect(candidates({ speakers: named }).map((candidate) => candidate.name)).toEqual(['Chad']);
  });

  it('leaves out a sample that could never match anyone', () => {
    expect(candidates({ embeddingsByLabel: { speaker_0: [0, 0], speaker_1: [NaN, 1] } })).toEqual(
      [],
    );
  });

  it('names speakers the way the transcript does, even when an earlier one is left out', () => {
    const [only] = candidates({ embeddingsByLabel: { speaker_1: [0.3, 0.4] } });
    expect(only.name).toBe('Speaker 2');
  });
});

describe('formatSpeakingTime', () => {
  it('reads as a duration', () => {
    expect(formatSpeakingTime(12_000)).toBe('12 sec');
    expect(formatSpeakingTime(59_400)).toBe('59 sec');
    expect(formatSpeakingTime(65_000)).toBe('1 min');
    expect(formatSpeakingTime(28 * 60_000)).toBe('28 min');
  });
});
