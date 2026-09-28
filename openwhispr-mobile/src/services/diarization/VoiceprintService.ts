import type { NewSpeakerProfile, NotesRepository, Speaker, SpeakerProfile } from '@/data/types';
import type { DiarizationResult, Diarizer } from '@/lib/diarization/diarizer';
import {
  averageEmbeddings,
  buildAutoLabelSpeakerPatch,
  buildSuggestedSpeakerPatch,
  hasFiniteNonZeroNorm,
  l2Normalize,
  matchSpeakerEmbeddings,
  type VoiceprintDecision,
  type VoiceprintMatch,
} from '@/lib/diarization/voiceprints';
import type { SpeechActivityContext } from '@/lib/speechActivity';
import type { SpeechActivityAnalysis } from '../../../modules/app-group-storage/src';

export const ENROLLMENT_MIN_SPEECH_ACTIVITY_MS = 10_000;
export const ENROLLMENT_MIN_SPEECH_RATIO = 0.35;
export const ENROLLMENT_MIN_SNR_DB = 12;
export const ENROLLMENT_MEANINGFUL_SPEAKER_MS = 1_500;
export const ENROLLMENT_MIN_TAKES = 1;
export const ENROLLMENT_MAX_TAKES = 3;

export const VOICE_ENROLLMENT_CONSENT_REQUIRED = 'VOICE_ENROLLMENT_CONSENT_REQUIRED' as const;
export const VOICE_ENROLLMENT_INVALID_CONSENT_TIMESTAMP =
  'VOICE_ENROLLMENT_INVALID_CONSENT_TIMESTAMP' as const;
export const VOICE_ENROLLMENT_INVALID_RECORDINGS = 'VOICE_ENROLLMENT_INVALID_RECORDINGS' as const;
export const VOICE_ENROLLMENT_DISPLAY_NAME_REQUIRED =
  'VOICE_ENROLLMENT_DISPLAY_NAME_REQUIRED' as const;
export const VOICE_ENROLLMENT_PROFILE_NOT_FOUND = 'VOICE_ENROLLMENT_PROFILE_NOT_FOUND' as const;
export const VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED =
  'VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED' as const;
export const VOICE_ENROLLMENT_TRANSCODE_UNAVAILABLE =
  'VOICE_ENROLLMENT_TRANSCODE_UNAVAILABLE' as const;
export const VOICE_ENROLLMENT_TRANSCODE_FAILED = 'VOICE_ENROLLMENT_TRANSCODE_FAILED' as const;
export const VOICE_ENROLLMENT_SPEECH_ANALYSIS_FAILED =
  'VOICE_ENROLLMENT_SPEECH_ANALYSIS_FAILED' as const;
export const VOICE_ENROLLMENT_DIARIZATION_FAILED = 'VOICE_ENROLLMENT_DIARIZATION_FAILED' as const;
export const VOICE_ENROLLMENT_STORAGE_FAILED = 'VOICE_ENROLLMENT_STORAGE_FAILED' as const;
export const VOICE_ENROLLMENT_NO_SPEECH = 'VOICE_ENROLLMENT_NO_SPEECH' as const;
export const VOICE_ENROLLMENT_SHORT_SPEECH = 'VOICE_ENROLLMENT_SHORT_SPEECH' as const;
export const VOICE_ENROLLMENT_LOW_SPEECH_RATIO = 'VOICE_ENROLLMENT_LOW_SPEECH_RATIO' as const;
export const VOICE_ENROLLMENT_LOW_SNR = 'VOICE_ENROLLMENT_LOW_SNR' as const;
export const VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER =
  'VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER' as const;
export const VOICE_ENROLLMENT_MULTIPLE_SPEAKERS = 'VOICE_ENROLLMENT_MULTIPLE_SPEAKERS' as const;
export const VOICE_ENROLLMENT_NO_USABLE_EMBEDDING = 'VOICE_ENROLLMENT_NO_USABLE_EMBEDDING' as const;
export const VOICE_ENROLLMENT_INVALID_EMBEDDING = 'VOICE_ENROLLMENT_INVALID_EMBEDDING' as const;

export type EnrollmentQualityFailureCode =
  | typeof VOICE_ENROLLMENT_NO_SPEECH
  | typeof VOICE_ENROLLMENT_SHORT_SPEECH
  | typeof VOICE_ENROLLMENT_LOW_SPEECH_RATIO
  | typeof VOICE_ENROLLMENT_LOW_SNR
  | typeof VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER
  | typeof VOICE_ENROLLMENT_MULTIPLE_SPEAKERS
  | typeof VOICE_ENROLLMENT_NO_USABLE_EMBEDDING
  | typeof VOICE_ENROLLMENT_INVALID_EMBEDDING;

export type VoiceEnrollmentErrorCode =
  | typeof VOICE_ENROLLMENT_CONSENT_REQUIRED
  | typeof VOICE_ENROLLMENT_INVALID_CONSENT_TIMESTAMP
  | typeof VOICE_ENROLLMENT_INVALID_RECORDINGS
  | typeof VOICE_ENROLLMENT_DISPLAY_NAME_REQUIRED
  | typeof VOICE_ENROLLMENT_PROFILE_NOT_FOUND
  | typeof VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED
  | typeof VOICE_ENROLLMENT_TRANSCODE_UNAVAILABLE
  | typeof VOICE_ENROLLMENT_TRANSCODE_FAILED
  | typeof VOICE_ENROLLMENT_SPEECH_ANALYSIS_FAILED
  | typeof VOICE_ENROLLMENT_DIARIZATION_FAILED
  | typeof VOICE_ENROLLMENT_STORAGE_FAILED
  | EnrollmentQualityFailureCode;

export class VoiceEnrollmentError extends Error {
  readonly code: VoiceEnrollmentErrorCode;
  readonly quality?: EnrollmentQualityResult;

  constructor(code: VoiceEnrollmentErrorCode, message: string, quality?: EnrollmentQualityResult) {
    super(message);
    this.name = 'VoiceEnrollmentError';
    this.code = code;
    this.quality = quality;
  }
}

export interface EnrollmentRecording {
  uri: string;
  mimeType?: string | null;
}

export interface ExtractEnrollmentEmbeddingInput {
  recordings: EnrollmentRecording[];
}

export interface EnrollVoiceProfileInput extends ExtractEnrollmentEmbeddingInput {
  displayName?: string;
  email?: string | null;
  isOwner?: boolean;
  consentAccepted: boolean;
  consentAcceptedAt: string;
}

export interface ReenrollVoiceProfileInput extends ExtractEnrollmentEmbeddingInput {
  profileId: number;
  displayName?: string;
  email?: string | null;
  consentAccepted: boolean;
  consentAcceptedAt: string;
}

export interface EnrollmentEmbeddingResult {
  embedding: number[];
  sampleCount: number;
  takes: Array<{
    inputUri: string;
    wavUri: string;
    speakerId: number;
    speechActivity: SpeechActivityAnalysis;
    speakerDurationsMs: Record<number, number>;
  }>;
}

export type EnrollmentQualityResult =
  | {
      ok: true;
      speakerId: number;
      embedding: number[];
      speechActivity: SpeechActivityAnalysis;
      speakerDurationsMs: Record<number, number>;
    }
  | {
      ok: false;
      code: EnrollmentQualityFailureCode;
      reason: string;
      speakerDurationsMs?: Record<number, number>;
    };

export interface EnrollmentQualityInput {
  speechActivity: SpeechActivityAnalysis | null;
  diarization: DiarizationResult;
  meaningfulSpeakerMs?: number;
  minSpeechActivityMs?: number;
  minSpeechRatio?: number;
  minSnrDb?: number;
}

export interface SpeechActivityQualityInput {
  speechActivity: SpeechActivityAnalysis | null;
  minSpeechActivityMs?: number;
  minSpeechRatio?: number;
  minSnrDb?: number;
}

export type SpeechActivityQualityResult =
  | {
      ok: true;
      speechActivity: SpeechActivityAnalysis;
    }
  | {
      ok: false;
      code: EnrollmentQualityFailureCode;
      reason: string;
    };

export interface EnrollmentAudioTools {
  transcodeToWav(inputUri: string): Promise<{ uri: string; durationMs: number }>;
  cleanup?(uris: string[]): Promise<void>;
}

export interface ExtractEnrollmentEmbeddingDeps {
  diarizer: Diarizer;
  analyzeSpeechActivity: (
    wavUri: string,
    context: SpeechActivityContext,
  ) => Promise<SpeechActivityAnalysis | null>;
  audioTools?: EnrollmentAudioTools;
}

export interface EnrollVoiceProfileDeps extends ExtractEnrollmentEmbeddingDeps {
  repo: Pick<NotesRepository, 'createSpeakerProfile'>;
}

export interface ReenrollVoiceProfileDeps extends ExtractEnrollmentEmbeddingDeps {
  repo: Pick<NotesRepository, 'getSpeakerProfileById' | 'updateSpeakerProfile'>;
}

export interface IdentifyNoteSpeakersDeps {
  repo: Pick<NotesRepository, 'getSpeakerProfiles' | 'getSpeakers' | 'updateSpeaker'>;
}

export interface IdentifyNoteSpeakersOptions {
  preferredProfileEmails?: string[];
}

export interface VoiceprintSpeakerIdentificationDecision {
  speakerId: number;
  speakerLabel: string;
  decision: VoiceprintDecision;
  profileId: number | null;
}

export interface VoiceprintIdentificationResult {
  decisions: VoiceprintSpeakerIdentificationDecision[];
  updatedSpeakerIds: number[];
}

const isWavRecording = (recording: EnrollmentRecording): boolean => {
  const mimeType = recording.mimeType?.toLowerCase();
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav' || mimeType === 'audio/wave') {
    return true;
  }
  return /\.wav(?:$|[?#])/i.test(recording.uri);
};

const computeSpeakerDurationsMs = (diarization: DiarizationResult): Record<number, number> => {
  const durations: Record<number, number> = {};
  diarization.segments.forEach((segment) => {
    if (segment.speakerId === null) return;
    const durationMs = Math.max(0, segment.end - segment.start) * 1000;
    durations[segment.speakerId] = (durations[segment.speakerId] ?? 0) + durationMs;
  });
  return durations;
};

const failQuality = (
  code: EnrollmentQualityFailureCode,
  reason: string,
  speakerDurationsMs?: Record<number, number>,
): EnrollmentQualityResult => ({
  ok: false,
  code,
  reason,
  speakerDurationsMs,
});

const isOwnerAlreadyExistsError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'SPEAKER_PROFILE_OWNER_ALREADY_EXISTS';

const wrapProfileStorageError = (error: unknown): never => {
  if (isOwnerAlreadyExistsError(error)) throw error;
  throw new VoiceEnrollmentError(
    VOICE_ENROLLMENT_STORAGE_FAILED,
    'Voice enrollment could not save this profile. Try again.',
  );
};

export const evaluateEnrollmentQuality = (
  input: EnrollmentQualityInput,
): EnrollmentQualityResult => {
  const meaningfulSpeakerMs = input.meaningfulSpeakerMs ?? ENROLLMENT_MEANINGFUL_SPEAKER_MS;
  const minSpeechActivityMs = input.minSpeechActivityMs ?? ENROLLMENT_MIN_SPEECH_ACTIVITY_MS;
  const speechQuality = evaluateSpeechActivityQuality({ ...input, minSpeechActivityMs: 0 });
  const { diarization } = input;

  if (!speechQuality.ok) return speechQuality;

  const speakerDurationsMs = computeSpeakerDurationsMs(diarization);
  const meaningfulSpeakerIds = Object.entries(speakerDurationsMs)
    .filter(([, durationMs]) => durationMs >= meaningfulSpeakerMs)
    .map(([speakerId]) => Number(speakerId));

  if (meaningfulSpeakerIds.length === 0) {
    return failQuality(
      VOICE_ENROLLMENT_NO_MEANINGFUL_SPEAKER,
      `No speaker had at least ${meaningfulSpeakerMs}ms of attributed speech.`,
      speakerDurationsMs,
    );
  }
  if (meaningfulSpeakerIds.length > 1) {
    return failQuality(
      VOICE_ENROLLMENT_MULTIPLE_SPEAKERS,
      'More than one speaker was detected in the enrollment recording.',
      speakerDurationsMs,
    );
  }

  const speakerId = meaningfulSpeakerIds[0];
  const acceptedSpeakerMs = speakerDurationsMs[speakerId] ?? 0;
  const usableSpeechMs = Math.max(speechQuality.speechActivity.speechActivityMs, acceptedSpeakerMs);
  if (usableSpeechMs < minSpeechActivityMs) {
    return failQuality(
      VOICE_ENROLLMENT_SHORT_SPEECH,
      `Detected ${Math.round(usableSpeechMs)}ms of usable speech; at least ${minSpeechActivityMs}ms is required.`,
      speakerDurationsMs,
    );
  }

  const embedding = diarization.embeddings[speakerId];
  if (!embedding) {
    return failQuality(
      VOICE_ENROLLMENT_NO_USABLE_EMBEDDING,
      'The accepted speaker did not include an embedding.',
      speakerDurationsMs,
    );
  }
  if (!hasFiniteNonZeroNorm(embedding)) {
    return failQuality(
      VOICE_ENROLLMENT_INVALID_EMBEDDING,
      'The accepted speaker embedding was empty, zero, or non-finite.',
      speakerDurationsMs,
    );
  }

  const normalizedEmbedding = l2Normalize(embedding);
  if (!hasFiniteNonZeroNorm(normalizedEmbedding)) {
    return failQuality(
      VOICE_ENROLLMENT_INVALID_EMBEDDING,
      'The normalized accepted speaker embedding was not usable.',
      speakerDurationsMs,
    );
  }

  return {
    ok: true,
    speakerId,
    embedding: normalizedEmbedding,
    speechActivity: speechQuality.speechActivity,
    speakerDurationsMs,
  };
};

export const evaluateSpeechActivityQuality = (
  input: SpeechActivityQualityInput,
): SpeechActivityQualityResult => {
  const minSpeechActivityMs = input.minSpeechActivityMs ?? ENROLLMENT_MIN_SPEECH_ACTIVITY_MS;
  const minSpeechRatio = input.minSpeechRatio ?? ENROLLMENT_MIN_SPEECH_RATIO;
  const minSnrDb = input.minSnrDb ?? ENROLLMENT_MIN_SNR_DB;
  const { speechActivity } = input;

  if (!speechActivity || speechActivity.noSpeechLikely) {
    return failQuality(
      VOICE_ENROLLMENT_NO_SPEECH,
      speechActivity?.reason ?? 'No speech was detected in the enrollment recording.',
    );
  }
  if (speechActivity.speechActivityMs < minSpeechActivityMs) {
    return failQuality(
      VOICE_ENROLLMENT_SHORT_SPEECH,
      `Speech activity is below ${minSpeechActivityMs}ms.`,
    );
  }
  if (speechActivity.speechRatio < minSpeechRatio) {
    return failQuality(
      VOICE_ENROLLMENT_LOW_SPEECH_RATIO,
      `Speech ratio is below ${minSpeechRatio}.`,
    );
  }
  if (speechActivity.peakDb - speechActivity.noiseFloorDb < minSnrDb) {
    return failQuality(VOICE_ENROLLMENT_LOW_SNR, `SNR proxy is below ${minSnrDb}dB.`);
  }

  return { ok: true, speechActivity };
};

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const isValidConsentTimestamp = (value: string): boolean => {
  if (!ISO_INSTANT_RE.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  return canonical === value || canonical === value.replace('Z', '.000Z');
};

const assertRecordingCount = (recordings: EnrollmentRecording[]): void => {
  if (recordings.length < ENROLLMENT_MIN_TAKES || recordings.length > ENROLLMENT_MAX_TAKES) {
    throw new VoiceEnrollmentError(
      VOICE_ENROLLMENT_INVALID_RECORDINGS,
      `Enrollment requires ${ENROLLMENT_MIN_TAKES}-${ENROLLMENT_MAX_TAKES} accepted recordings.`,
    );
  }
};

const assertEnrollmentConsent = (input: {
  consentAccepted: boolean;
  consentAcceptedAt: string;
}): void => {
  if (!input.consentAccepted) {
    throw new VoiceEnrollmentError(
      VOICE_ENROLLMENT_CONSENT_REQUIRED,
      'Voice enrollment requires accepted consent.',
    );
  }
  if (!isValidConsentTimestamp(input.consentAcceptedAt)) {
    throw new VoiceEnrollmentError(
      VOICE_ENROLLMENT_INVALID_CONSENT_TIMESTAMP,
      'Voice enrollment consent timestamp is invalid.',
    );
  }
};

const resolveWavUri = async (
  recording: EnrollmentRecording,
  deps: ExtractEnrollmentEmbeddingDeps,
): Promise<{ wavUri: string; cleanupUris: string[] }> => {
  if (deps.audioTools) {
    let transcoded: Awaited<ReturnType<EnrollmentAudioTools['transcodeToWav']>>;
    try {
      transcoded = await deps.audioTools.transcodeToWav(recording.uri);
    } catch {
      throw new VoiceEnrollmentError(
        VOICE_ENROLLMENT_TRANSCODE_FAILED,
        'Voice enrollment could not prepare this recording. Try another take.',
      );
    }
    return {
      wavUri: transcoded.uri,
      cleanupUris: transcoded.uri === recording.uri ? [] : [transcoded.uri],
    };
  }
  if (isWavRecording(recording)) {
    return { wavUri: recording.uri, cleanupUris: [] };
  }
  throw new VoiceEnrollmentError(
    VOICE_ENROLLMENT_TRANSCODE_UNAVAILABLE,
    'Audio transcoding is required for non-WAV enrollment recordings.',
  );
};

const processEnrollmentRecording = async (
  recording: EnrollmentRecording,
  deps: ExtractEnrollmentEmbeddingDeps,
): Promise<EnrollmentEmbeddingResult['takes'][number] & { embedding: number[] }> => {
  const { wavUri, cleanupUris } = await resolveWavUri(recording, deps);
  try {
    let speechActivity: SpeechActivityAnalysis | null;
    try {
      speechActivity = await deps.analyzeSpeechActivity(wavUri, 'recording');
    } catch {
      throw new VoiceEnrollmentError(
        VOICE_ENROLLMENT_SPEECH_ANALYSIS_FAILED,
        'Voice enrollment could not inspect this recording. Try another take.',
      );
    }
    const speechQuality = evaluateSpeechActivityQuality({ speechActivity, minSpeechActivityMs: 0 });
    if (!speechQuality.ok) {
      throw new VoiceEnrollmentError(speechQuality.code, speechQuality.reason, speechQuality);
    }
    let diarization: DiarizationResult;
    try {
      diarization = await deps.diarizer.diarize(wavUri, 0);
    } catch {
      throw new VoiceEnrollmentError(
        VOICE_ENROLLMENT_DIARIZATION_FAILED,
        'Voice enrollment could not analyze this recording. Try another take in a quiet room.',
      );
    }
    const quality = evaluateEnrollmentQuality({ speechActivity, diarization });
    if (!quality.ok) {
      throw new VoiceEnrollmentError(quality.code, quality.reason, quality);
    }
    return {
      inputUri: recording.uri,
      wavUri,
      speakerId: quality.speakerId,
      embedding: quality.embedding,
      speechActivity: quality.speechActivity,
      speakerDurationsMs: quality.speakerDurationsMs,
    };
  } finally {
    if (cleanupUris.length > 0 && deps.audioTools?.cleanup) {
      try {
        await deps.audioTools.cleanup(cleanupUris);
      } catch {
        // Cleanup is best-effort here; enrollment failures must preserve their original cause.
      }
    }
  }
};

export const extractEnrollmentEmbedding = async (
  input: ExtractEnrollmentEmbeddingInput,
  deps: ExtractEnrollmentEmbeddingDeps,
): Promise<EnrollmentEmbeddingResult> => {
  assertRecordingCount(input.recordings);

  const takeResults = [];
  for (const recording of input.recordings) {
    takeResults.push(await processEnrollmentRecording(recording, deps));
  }

  const embedding = averageEmbeddings(takeResults.map((take) => take.embedding));
  if (!hasFiniteNonZeroNorm(embedding)) {
    throw new VoiceEnrollmentError(
      VOICE_ENROLLMENT_INVALID_EMBEDDING,
      'Averaged enrollment embedding was empty, zero, or non-finite.',
    );
  }

  return {
    embedding,
    sampleCount: takeResults.length,
    takes: takeResults.map(({ embedding: _embedding, ...take }) => take),
  };
};

export const enrollVoiceProfile = async (
  input: EnrollVoiceProfileInput,
  deps: EnrollVoiceProfileDeps,
): Promise<SpeakerProfile> => {
  assertEnrollmentConsent(input);

  const isOwner = input.isOwner ?? true;
  const trimmedDisplayName = input.displayName?.trim();
  if (!isOwner && !trimmedDisplayName) {
    throw new VoiceEnrollmentError(
      VOICE_ENROLLMENT_DISPLAY_NAME_REQUIRED,
      'Voice enrollment requires a display name for non-owner profiles.',
    );
  }

  const extraction = await extractEnrollmentEmbedding(input, deps);
  const displayName = trimmedDisplayName || 'Me';
  const profileInput: NewSpeakerProfile = {
    displayName,
    email: input.email ?? null,
    isOwner: isOwner ? 1 : 0,
    embedding: extraction.embedding,
    sampleCount: extraction.sampleCount,
    consentAt: input.consentAcceptedAt,
  };

  try {
    return deps.repo.createSpeakerProfile(profileInput);
  } catch (error) {
    return wrapProfileStorageError(error);
  }
};

export const reenrollVoiceProfile = async (
  input: ReenrollVoiceProfileInput,
  deps: ReenrollVoiceProfileDeps,
): Promise<SpeakerProfile> => {
  assertEnrollmentConsent(input);

  const existing = deps.repo.getSpeakerProfileById(input.profileId);
  if (!existing) {
    throw new VoiceEnrollmentError(
      VOICE_ENROLLMENT_PROFILE_NOT_FOUND,
      'Voice profile was not found.',
    );
  }

  const trimmedDisplayName = input.displayName?.trim();
  if (existing.isOwner !== 1 && input.displayName !== undefined && !trimmedDisplayName) {
    throw new VoiceEnrollmentError(
      VOICE_ENROLLMENT_DISPLAY_NAME_REQUIRED,
      'Voice enrollment requires a display name for non-owner profiles.',
    );
  }

  const extraction = await extractEnrollmentEmbedding(input, deps);
  try {
    deps.repo.updateSpeakerProfile(existing.id, {
      displayName: trimmedDisplayName || existing.displayName,
      email: input.email === undefined ? existing.email : input.email,
      embedding: extraction.embedding,
      sampleCount: extraction.sampleCount,
      consentAt: input.consentAcceptedAt,
    });
  } catch (error) {
    return wrapProfileStorageError(error);
  }

  return {
    ...existing,
    displayName: trimmedDisplayName || existing.displayName,
    email: input.email === undefined ? existing.email : input.email,
    embedding: extraction.embedding,
    sampleCount: extraction.sampleCount,
    consentAt: input.consentAcceptedAt,
  };
};

const getMatchedProfile = (
  match: VoiceprintMatch,
  profilesById: Map<number, SpeakerProfile>,
): SpeakerProfile | null => {
  if (match.profileId === null) return null;
  return profilesById.get(match.profileId) ?? null;
};

const buildIdentificationPatch = (
  speaker: Speaker,
  profile: SpeakerProfile | null,
  decision: VoiceprintDecision,
): Partial<Speaker> => {
  if (!profile) return {};
  if (decision === 'auto') return buildAutoLabelSpeakerPatch(speaker, profile);
  if (decision === 'suggest') return buildSuggestedSpeakerPatch(speaker, profile);
  return {};
};

export const identifyNoteSpeakers = (
  noteId: number,
  speakerEmbeddingsByLabel: Record<string, number[]>,
  deps: IdentifyNoteSpeakersDeps,
  options: IdentifyNoteSpeakersOptions = {},
): VoiceprintIdentificationResult => {
  const profiles = deps.repo.getSpeakerProfiles();
  if (profiles.length === 0) {
    return { decisions: [], updatedSpeakerIds: [] };
  }

  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const speakers = deps.repo.getSpeakers(noteId);
  const matchesByLabel = matchSpeakerEmbeddings(
    speakerEmbeddingsByLabel,
    profiles,
    {},
    {
      preferredEmails: options.preferredProfileEmails,
    },
  );
  const decisions: VoiceprintSpeakerIdentificationDecision[] = [];
  const updatedSpeakerIds: number[] = [];

  speakers.forEach((speaker) => {
    const match = matchesByLabel[speaker.speakerLabel];
    if (!match) return;

    const profile = getMatchedProfile(match, profilesById);
    const patch = buildIdentificationPatch(speaker, profile, match.decision);

    decisions.push({
      speakerId: speaker.id,
      speakerLabel: speaker.speakerLabel,
      decision: match.decision,
      profileId: match.profileId,
    });

    if (Object.keys(patch).length === 0) return;
    deps.repo.updateSpeaker(speaker.id, patch);
    updatedSpeakerIds.push(speaker.id);
  });

  return { decisions, updatedSpeakerIds };
};
