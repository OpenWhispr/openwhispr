import type { Speaker, SpeakerProfile } from '@/data/types';
import {
  averageEmbeddings,
  buildAutoLabelSpeakerPatch,
  buildConfirmedSpeakerPatch,
  buildRejectedSuggestionPatch,
  buildSuggestedSpeakerPatch,
  cosineSimilarity,
  DEFAULT_VOICEPRINT_THRESHOLDS,
  matchEmbedding,
  matchSpeakerEmbeddings,
  runningMeanEmbedding,
} from '../voiceprints';

const speaker = (overrides: Partial<Speaker> = {}): Speaker =>
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

const profile = (overrides: Partial<SpeakerProfile> = {}): SpeakerProfile =>
  ({
    id: 10,
    displayName: 'Alice',
    email: null,
    isOwner: 0,
    embedding: [1, 0],
    sampleCount: 1,
    consentAt: '2026-01-01T00:00:00.000Z',
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as SpeakerProfile;

describe('voiceprint vector helpers', () => {
  it('scores cosine similarity for identical, orthogonal, and opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('normalizes each sample before averaging and normalizes the result', () => {
    const average = averageEmbeddings([
      [10, 0],
      [0, 5],
    ]);

    expect(average[0]).toBeCloseTo(Math.SQRT1_2);
    expect(average[1]).toBeCloseTo(Math.SQRT1_2);
    expect(cosineSimilarity(average, average)).toBeCloseTo(1);
  });

  it('running mean is sample-count weighted and stores a normalized embedding', () => {
    const mean = runningMeanEmbedding([10, 0], 1, [0, 5], 3);

    expect(mean[0]).toBeCloseTo(1 / Math.sqrt(10));
    expect(mean[1]).toBeCloseTo(3 / Math.sqrt(10));
    expect(Math.hypot(...mean)).toBeCloseTo(1);
  });
});

describe('voiceprint matching', () => {
  it('exports canonical default thresholds for services and UI', () => {
    expect(DEFAULT_VOICEPRINT_THRESHOLDS).toEqual({
      autoLabel: 0.7,
      suggest: 0.55,
      tieMargin: 0.03,
    });
  });

  it('returns auto above 0.70', () => {
    expect(matchEmbedding([0.8, 0.6], [profile()])).toMatchObject({
      decision: 'auto',
      profileId: 10,
    });
  });

  it('returns suggest between 0.55 and 0.70', () => {
    expect(matchEmbedding([0.6, 0.8], [profile()])).toMatchObject({
      decision: 'suggest',
      profileId: 10,
    });
  });

  it('returns none below 0.55', () => {
    expect(matchEmbedding([0.5, Math.sqrt(0.75)], [profile()])).toMatchObject({
      decision: 'none',
      profileId: null,
    });
  });

  it('returns tie for close top scores inside the anti-tie margin', () => {
    const result = matchEmbedding(
      [1, 0],
      [
        profile({ id: 10, embedding: [1, 0] }),
        profile({ id: 11, embedding: [0.98, Math.sqrt(1 - 0.98 ** 2)] }),
      ],
    );

    expect(result.decision).toBe('tie');
    expect(result.profileId).toBeNull();
    expect(result.score - (result.runnerUpScore ?? 0)).toBeLessThan(0.03);
  });

  it('normalizes stored profiles and incoming meeting embeddings before scoring', () => {
    const result = matchEmbedding(
      [60, 80],
      [profile({ id: 10, embedding: [6, 8] }), profile({ id: 11, embedding: [8, -6] })],
    );

    expect(result).toMatchObject({
      decision: 'auto',
      profileId: 10,
    });
    expect(result.score).toBeCloseTo(1);
  });

  it('returns none for non-finite, empty, or dimension-mismatched embeddings', () => {
    expect(matchEmbedding([NaN], [profile({ embedding: [1] })])).toMatchObject({
      decision: 'none',
      profileId: null,
      score: 0,
    });
    expect(matchEmbedding([], [profile({ embedding: [] })])).toMatchObject({
      decision: 'none',
      profileId: null,
      score: 0,
    });
    expect(matchEmbedding([1], [profile({ embedding: [1, 0] })])).toMatchObject({
      decision: 'none',
      profileId: null,
      score: 0,
      runnerUpScore: null,
    });
  });

  it('ignores invalid profiles instead of ranking unstable scores', () => {
    expect(
      matchEmbedding(
        [1, 0],
        [profile({ id: 10, embedding: [NaN, 0] }), profile({ id: 11, embedding: [1, 0] })],
      ),
    ).toMatchObject({
      decision: 'auto',
      profileId: 11,
      score: 1,
    });
  });

  it('matches all speaker embeddings by label', () => {
    expect(
      matchSpeakerEmbeddings(
        {
          SPEAKER_00: [1, 0],
          SPEAKER_01: [0.6, 0.8],
        },
        [profile()],
      ),
    ).toMatchObject({
      SPEAKER_00: { decision: 'auto', profileId: 10 },
      SPEAKER_01: { decision: 'suggest', profileId: 10 },
    });
  });

  it('does not label from a preferred email when embedding confidence is too low', () => {
    expect(
      matchSpeakerEmbeddings(
        { SPEAKER_00: [0, 1] },
        [profile({ id: 10, email: 'alice@example.com', embedding: [1, 0] })],
        {},
        { preferredEmails: ['alice@example.com'] },
      ),
    ).toMatchObject({
      SPEAKER_00: { decision: 'none', profileId: null },
    });
  });

  it('prefers attendee-email profiles that still meet voiceprint thresholds', () => {
    expect(
      matchSpeakerEmbeddings(
        { SPEAKER_00: [1, 0] },
        [
          profile({
            id: 10,
            email: 'alice@example.com',
            embedding: [0.72, Math.sqrt(1 - 0.72 ** 2)],
          }),
          profile({ id: 11, email: 'carol@example.com', embedding: [1, 0] }),
        ],
        {},
        { preferredEmails: ['alice@example.com'] },
      ),
    ).toMatchObject({
      SPEAKER_00: { decision: 'auto', profileId: 10 },
    });
  });

  it('falls back to all profiles when preferred email candidates do not match', () => {
    expect(
      matchSpeakerEmbeddings(
        { SPEAKER_00: [1, 0] },
        [
          profile({ id: 10, email: 'alice@example.com', embedding: [0, 1] }),
          profile({ id: 11, email: 'carol@example.com', embedding: [1, 0] }),
        ],
        {},
        { preferredEmails: ['alice@example.com'] },
      ),
    ).toMatchObject({
      SPEAKER_00: { decision: 'auto', profileId: 11, score: 1 },
    });
  });

  it('normalizes stored profiles for batched speaker matching', () => {
    expect(
      matchSpeakerEmbeddings(
        {
          SPEAKER_00: [60, 80],
          SPEAKER_01: [8, -6],
        },
        [profile({ id: 10, embedding: [6, 8] }), profile({ id: 11, embedding: [8, -6] })],
      ),
    ).toMatchObject({
      SPEAKER_00: { decision: 'auto', profileId: 10, score: 1 },
      SPEAKER_01: { decision: 'auto', profileId: 11, score: 1 },
    });
  });
});

describe('voiceprint speaker patches', () => {
  it('auto patch confirms and links a profile without locking the speaker', () => {
    expect(buildAutoLabelSpeakerPatch(speaker(), profile())).toEqual({
      displayName: 'Alice',
      speakerStatus: 'confirmed',
      speakerLocked: 0,
      speakerLockSource: null,
      profileId: 10,
    });
  });

  it('suggest patch marks tentative display state and links a profile', () => {
    expect(buildSuggestedSpeakerPatch(speaker(), profile())).toEqual({
      displayName: 'Alice',
      speakerStatus: 'suggested',
      speakerLocked: 0,
      speakerLockSource: null,
      profileId: 10,
    });
  });

  it('auto and suggest patches never override a locked speaker', () => {
    const locked = speaker({
      displayName: 'Locked Alice',
      speakerStatus: 'locked',
      speakerLocked: 1,
      speakerLockSource: 'user',
      profileId: 42,
    });

    expect(buildAutoLabelSpeakerPatch(locked, profile({ displayName: 'Bob', id: 11 }))).toEqual({});
    expect(buildSuggestedSpeakerPatch(locked, profile({ displayName: 'Bob', id: 11 }))).toEqual({});
  });

  it('confirm locks the speaker and preserves the selected profileId', () => {
    expect(
      buildConfirmedSpeakerPatch(speaker(), profile({ id: 77, displayName: 'Carol' })),
    ).toEqual({
      displayName: 'Carol',
      speakerStatus: 'locked',
      speakerLocked: 1,
      speakerLockSource: 'user',
      profileId: 77,
    });
  });

  it('confirm is a no-op for locked speakers', () => {
    expect(
      buildConfirmedSpeakerPatch(
        speaker({ speakerStatus: 'confirmed', speakerLocked: 1, speakerLockSource: 'user' }),
        profile(),
      ),
    ).toEqual({});
  });

  it('reject suggestion clears only tentative speaker state', () => {
    expect(
      buildRejectedSuggestionPatch(
        speaker({
          displayName: 'Suggested Alice',
          profileId: 10,
          color: '#123456',
          speakerStatus: 'suggested',
          speakerLocked: 0,
          speakerLockSource: 'suggestion',
        }),
      ),
    ).toEqual({
      displayName: null,
      profileId: null,
      speakerStatus: 'provisional',
      speakerLocked: 0,
      speakerLockSource: null,
    });
  });

  it('reject suggestion is a no-op unless the speaker is an unlocked suggestion', () => {
    expect(buildRejectedSuggestionPatch(speaker({ speakerStatus: 'confirmed' }))).toEqual({});
    expect(
      buildRejectedSuggestionPatch(
        speaker({ speakerStatus: 'suggested', speakerLocked: 1, speakerLockSource: 'user' }),
      ),
    ).toEqual({});
  });
});
