import type { Speaker, SpeakerProfile } from '@/data/types';
import { speakerRowToState, speakerStateToRowPatch } from './speakerEdits';
import { applyConfirmed, applySuggested, isLocked, lockSpeaker } from './speakerState';

export interface VoiceprintThresholds {
  autoLabel: number;
  suggest: number;
  tieMargin: number;
}

export type VoiceprintDecision = 'auto' | 'suggest' | 'none' | 'tie';

export interface VoiceprintMatch {
  decision: VoiceprintDecision;
  profileId: number | null;
  score: number;
  runnerUpScore: number | null;
}

export interface VoiceprintMatchOptions {
  preferredEmails?: string[];
}

export const DEFAULT_VOICEPRINT_THRESHOLDS: VoiceprintThresholds = {
  autoLabel: 0.7,
  suggest: 0.55,
  tieMargin: 0.03,
};

type MatchableProfile = Pick<SpeakerProfile, 'id' | 'embedding'> & {
  email?: string | null;
};

export const isValidEmbedding = (values: number[] | undefined): values is number[] =>
  Array.isArray(values) && values.length > 0 && values.every((value) => Number.isFinite(value));

const hasSameDimension = (a: number[], b: number[]): boolean => a.length === b.length;

const vectorLength = (values: number[]): number =>
  Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));

export const hasFiniteNonZeroNorm = (values: number[] | undefined): values is number[] =>
  isValidEmbedding(values) && vectorLength(values) > 0;

const dotProduct = (a: number[], b: number[]): number => {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
  }
  return dot;
};

export const l2Normalize = (values: number[]): number[] => {
  if (!isValidEmbedding(values)) return [];
  const length = vectorLength(values);
  if (length === 0) return values.map(() => 0);
  return values.map((value) => value / length);
};

export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (!isValidEmbedding(a) || !isValidEmbedding(b) || !hasSameDimension(a, b)) return 0;
  const normalizedA = l2Normalize(a);
  const normalizedB = l2Normalize(b);

  return dotProduct(normalizedA, normalizedB);
};

export const averageEmbeddings = (samples: number[][]): number[] => {
  const validSamples = samples.filter(isValidEmbedding);
  if (validSamples.length === 0) return [];

  const dimension = validSamples[0].length;
  if (!validSamples.every((sample) => sample.length === dimension)) return [];

  const normalizedSamples = validSamples.map(l2Normalize);
  const average = Array.from({ length: dimension }, (_, index) => {
    const sum = normalizedSamples.reduce((total, sample) => total + (sample[index] ?? 0), 0);
    return sum / normalizedSamples.length;
  });

  return l2Normalize(average);
};

export const runningMeanEmbedding = (
  existing: number[],
  existingSampleCount: number,
  incoming: number[],
  incomingSampleCount: number,
): number[] => {
  const existingWeight = Math.max(0, existingSampleCount);
  const incomingWeight = Math.max(0, incomingSampleCount);
  const totalWeight = existingWeight + incomingWeight;

  if (totalWeight === 0) return [];
  if (existingWeight === 0) return isValidEmbedding(incoming) ? l2Normalize(incoming) : [];
  if (incomingWeight === 0) return isValidEmbedding(existing) ? l2Normalize(existing) : [];
  if (
    !isValidEmbedding(existing) ||
    !isValidEmbedding(incoming) ||
    !hasSameDimension(existing, incoming)
  ) {
    return [];
  }

  const normalizedExisting = l2Normalize(existing);
  const normalizedIncoming = l2Normalize(incoming);
  const dimension = normalizedExisting.length;
  const mean = Array.from({ length: dimension }, (_, index) => {
    const weightedExisting = (normalizedExisting[index] ?? 0) * existingWeight;
    const weightedIncoming = (normalizedIncoming[index] ?? 0) * incomingWeight;
    return (weightedExisting + weightedIncoming) / totalWeight;
  });

  return l2Normalize(mean);
};

type RankedVoiceprintMatch = Pick<VoiceprintMatch, 'profileId' | 'score'>;

const noVoiceprintMatch = (): VoiceprintMatch => ({
  decision: 'none',
  profileId: null,
  score: 0,
  runnerUpScore: null,
});

const normalizeMatchableProfiles = (profiles: MatchableProfile[]): MatchableProfile[] =>
  profiles
    .filter((profile) => isValidEmbedding(profile.embedding))
    .map((profile) => ({
      id: profile.id,
      email: profile.email?.trim().toLowerCase() || null,
      embedding: l2Normalize(profile.embedding),
    }));

const rankNormalizedProfiles = (
  normalizedEmbedding: number[],
  normalizedProfiles: MatchableProfile[],
): RankedVoiceprintMatch[] =>
  normalizedProfiles
    .filter((profile) => hasSameDimension(normalizedEmbedding, profile.embedding))
    .map((profile) => ({
      profileId: profile.id,
      score: dotProduct(normalizedEmbedding, profile.embedding),
    }))
    .sort((a, b) => b.score - a.score);

const resolveVoiceprintMatch = (
  ranked: RankedVoiceprintMatch[],
  resolvedThresholds: VoiceprintThresholds,
): VoiceprintMatch => {
  const best = ranked[0];
  if (!best) return noVoiceprintMatch();

  const runnerUpScore = ranked[1]?.score ?? null;
  const isTie =
    runnerUpScore !== null &&
    best.score >= resolvedThresholds.suggest &&
    best.score - runnerUpScore < resolvedThresholds.tieMargin;

  if (isTie) {
    return {
      decision: 'tie',
      profileId: null,
      score: best.score,
      runnerUpScore,
    };
  }

  if (best.score >= resolvedThresholds.autoLabel) {
    return {
      decision: 'auto',
      profileId: best.profileId,
      score: best.score,
      runnerUpScore,
    };
  }

  if (best.score >= resolvedThresholds.suggest) {
    return {
      decision: 'suggest',
      profileId: best.profileId,
      score: best.score,
      runnerUpScore,
    };
  }

  return {
    decision: 'none',
    profileId: null,
    score: best.score,
    runnerUpScore,
  };
};

const matchEmbeddingAgainstNormalizedProfiles = (
  embedding: number[],
  normalizedProfiles: MatchableProfile[],
  thresholds: Partial<VoiceprintThresholds> = {},
  options: VoiceprintMatchOptions = {},
): VoiceprintMatch => {
  const resolvedThresholds = { ...DEFAULT_VOICEPRINT_THRESHOLDS, ...thresholds };
  if (!isValidEmbedding(embedding)) return noVoiceprintMatch();

  const normalizedEmbedding = l2Normalize(embedding);
  const preferredEmails = new Set(
    (options.preferredEmails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean),
  );
  const preferredProfiles =
    preferredEmails.size > 0
      ? normalizedProfiles.filter((profile) => profile.email && preferredEmails.has(profile.email))
      : [];

  if (preferredProfiles.length > 0) {
    const preferredMatch = resolveVoiceprintMatch(
      rankNormalizedProfiles(normalizedEmbedding, preferredProfiles),
      resolvedThresholds,
    );
    if (preferredMatch.decision === 'auto' || preferredMatch.decision === 'suggest') {
      return preferredMatch;
    }
  }

  return resolveVoiceprintMatch(
    rankNormalizedProfiles(normalizedEmbedding, normalizedProfiles),
    resolvedThresholds,
  );
};

export const matchEmbedding = (
  embedding: number[],
  profiles: MatchableProfile[],
  thresholds: Partial<VoiceprintThresholds> = {},
  options: VoiceprintMatchOptions = {},
): VoiceprintMatch => {
  const normalizedProfiles = normalizeMatchableProfiles(profiles);
  return matchEmbeddingAgainstNormalizedProfiles(
    embedding,
    normalizedProfiles,
    thresholds,
    options,
  );
};

export const matchSpeakerEmbeddings = (
  speakerEmbeddingsByLabel: Record<string, number[]>,
  profiles: MatchableProfile[],
  thresholds: Partial<VoiceprintThresholds> = {},
  options: VoiceprintMatchOptions = {},
): Record<string, VoiceprintMatch> => {
  const normalizedProfiles = normalizeMatchableProfiles(profiles);
  return Object.fromEntries(
    Object.entries(speakerEmbeddingsByLabel).map(([label, embedding]) => [
      label,
      matchEmbeddingAgainstNormalizedProfiles(embedding, normalizedProfiles, thresholds, options),
    ]),
  );
};

export const buildAutoLabelSpeakerPatch = (
  speaker: Speaker,
  profile: SpeakerProfile,
): Partial<Speaker> => {
  const state = speakerRowToState(speaker);
  if (isLocked(state)) return {};

  return {
    ...speakerStateToRowPatch(applyConfirmed(state, { displayName: profile.displayName })),
    profileId: profile.id,
  };
};

export const buildSuggestedSpeakerPatch = (
  speaker: Speaker,
  profile: SpeakerProfile,
): Partial<Speaker> => {
  const state = speakerRowToState(speaker);
  if (isLocked(state)) return {};

  return {
    ...speakerStateToRowPatch(applySuggested(state, { displayName: profile.displayName })),
    profileId: profile.id,
  };
};

export const buildConfirmedSpeakerPatch = (
  speaker: Speaker,
  profile: SpeakerProfile,
): Partial<Speaker> => {
  const state = speakerRowToState(speaker);
  if (isLocked(state)) return {};

  return {
    ...speakerStateToRowPatch(lockSpeaker(state, { displayName: profile.displayName })),
    profileId: profile.id,
  };
};

export const buildRejectedSuggestionPatch = (speaker: Speaker): Partial<Speaker> => {
  const state = speakerRowToState(speaker);
  if (isLocked(state) || speaker.speakerStatus !== 'suggested') return {};

  return {
    displayName: null,
    profileId: null,
    speakerStatus: 'provisional',
    speakerLocked: 0,
    speakerLockSource: null,
  };
};
