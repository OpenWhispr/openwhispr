import type { Speaker, SpeakerProfile } from '@/data/types';
import type { DiarizationResult, Diarizer } from '@/lib/diarization/diarizer';
import type { SpeechActivityAnalysis } from '../../../../modules/app-group-storage/src';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';
import {
  enrollVoiceProfile,
  evaluateEnrollmentQuality,
  extractEnrollmentEmbedding,
  identifyNoteSpeakers,
  VoiceEnrollmentError,
  VOICE_ENROLLMENT_CONSENT_REQUIRED,
  VOICE_ENROLLMENT_DISPLAY_NAME_REQUIRED,
  VOICE_ENROLLMENT_INVALID_EMBEDDING,
  VOICE_ENROLLMENT_INVALID_CONSENT_TIMESTAMP,
  VOICE_ENROLLMENT_LOW_SPEECH_RATIO,
  VOICE_ENROLLMENT_LOW_SNR,
  VOICE_ENROLLMENT_MULTIPLE_SPEAKERS,
  VOICE_ENROLLMENT_NO_SPEECH,
  VOICE_ENROLLMENT_NO_USABLE_EMBEDDING,
  VOICE_ENROLLMENT_SPEECH_ANALYSIS_FAILED,
  VOICE_ENROLLMENT_STORAGE_FAILED,
  VOICE_ENROLLMENT_SHORT_SPEECH,
  VOICE_ENROLLMENT_TRANSCODE_FAILED,
  type EnrollVoiceProfileDeps,
  type IdentifyNoteSpeakersDeps,
} from '../VoiceprintService';

const passingAnalysis: SpeechActivityAnalysis = {
  durationMs: 15_000,
  analyzedMs: 15_000,
  speechActivityMs: 12_000,
  speechRatio: 0.8,
  peakDb: -8,
  averageDb: -20,
  noiseFloorDb: -28,
  thresholdDb: -24,
  noSpeechLikely: false,
  confidence: 0.95,
};

const diarization = (overrides: Partial<DiarizationResult> = {}): DiarizationResult => ({
  speakerCount: 1,
  segments: [{ start: 0, end: 12, speakerId: 0 }],
  embeddings: { 0: [10, 0] },
  ...overrides,
});

const profileFromInput = (
  input: Parameters<EnrollVoiceProfileDeps['repo']['createSpeakerProfile']>[0],
): SpeakerProfile =>
  ({
    id: 1,
    displayName: input.displayName,
    email: input.email ?? null,
    isOwner: input.isOwner ?? 0,
    embedding: input.embedding,
    sampleCount: input.sampleCount ?? 1,
    consentAt: input.consentAt,
    createdAt: null,
    updatedAt: null,
  }) as SpeakerProfile;

const profile = (overrides: Partial<SpeakerProfile> = {}): SpeakerProfile =>
  ({
    id: 10,
    displayName: 'Alice',
    email: null,
    isOwner: 1,
    embedding: [1, 0],
    sampleCount: 1,
    consentAt: '2026-06-19T12:00:00.000Z',
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as SpeakerProfile;

const speaker = (overrides: Partial<Speaker> = {}): Speaker =>
  ({
    id: 100,
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

const makeDeps = (
  overrides: {
    analysis?: SpeechActivityAnalysis | null;
    analysisError?: Error;
    diarization?: DiarizationResult | ((wavUri: string) => DiarizationResult);
    createSpeakerProfile?: EnrollVoiceProfileDeps['repo']['createSpeakerProfile'];
    transcodeError?: Error;
  } = {},
) => {
  const calls: {
    diarize: Array<[string, number | undefined]>;
    analyze: Array<[string, string]>;
    transcode: string[];
    cleanup: string[][];
    createSpeakerProfile: unknown[];
  } = {
    diarize: [],
    analyze: [],
    transcode: [],
    cleanup: [],
    createSpeakerProfile: [],
  };
  const createSpeakerProfile =
    overrides.createSpeakerProfile ??
    jest.fn((input) => {
      calls.createSpeakerProfile.push(input);
      return profileFromInput(input);
    });
  const deps: EnrollVoiceProfileDeps = {
    diarizer: {
      isAvailable: () => true,
      isModelDownloaded: async () => true,
      downloadModel: async () => undefined,
      diarize: async (wavUri: string, numberOfSpeakers?: number) => {
        calls.diarize.push([wavUri, numberOfSpeakers]);
        const value = overrides.diarization ?? diarization();
        return typeof value === 'function' ? value(wavUri) : value;
      },
    } as Diarizer,
    analyzeSpeechActivity: async (wavUri, context) => {
      calls.analyze.push([wavUri, context]);
      if (overrides.analysisError) throw overrides.analysisError;
      return overrides.analysis === undefined ? passingAnalysis : overrides.analysis;
    },
    audioTools: {
      transcodeToWav: async (inputUri) => {
        calls.transcode.push(inputUri);
        if (overrides.transcodeError) throw overrides.transcodeError;
        return {
          uri: inputUri.replace(/\.[^.?#]+(?:$|[?#].*)/, '.canonical.wav'),
          durationMs: 15_000,
        };
      },
      cleanup: async (uris) => {
        calls.cleanup.push(uris);
      },
    },
    repo: {
      createSpeakerProfile,
    },
  };
  return { deps, calls, createSpeakerProfile };
};

const enrollInput = {
  recordings: [{ uri: 'file://take1.wav', mimeType: 'audio/wav' }],
  consentAccepted: true,
  consentAcceptedAt: '2026-06-19T12:00:00.000Z',
};

describe('evaluateEnrollmentQuality', () => {
  it.each([
    [
      'no speech',
      { ...passingAnalysis, noSpeechLikely: true, reason: 'silence' },
      VOICE_ENROLLMENT_NO_SPEECH,
    ],
    [
      'low speech ratio',
      { ...passingAnalysis, speechRatio: 0.34 },
      VOICE_ENROLLMENT_LOW_SPEECH_RATIO,
    ],
    ['low SNR', { ...passingAnalysis, peakDb: -20, noiseFloorDb: -28 }, VOICE_ENROLLMENT_LOW_SNR],
  ])('rejects %s analysis', (_name, speechActivity, code) => {
    expect(evaluateEnrollmentQuality({ speechActivity, diarization: diarization() })).toMatchObject(
      {
        ok: false,
        code,
      },
    );
  });

  it('accepts VAD-short analysis when diarization attributes enough single-speaker speech', () => {
    expect(
      evaluateEnrollmentQuality({
        speechActivity: { ...passingAnalysis, speechActivityMs: 5_000 },
        diarization: diarization({
          segments: [{ start: 0, end: 12, speakerId: 0 }],
        }),
      }),
    ).toMatchObject({
      ok: true,
      speakerId: 0,
    });
  });

  it('rejects short speech when both VAD and diarization are below the duration floor', () => {
    expect(
      evaluateEnrollmentQuality({
        speechActivity: { ...passingAnalysis, speechActivityMs: 5_000 },
        diarization: diarization({
          segments: [{ start: 0, end: 5, speakerId: 0 }],
        }),
      }),
    ).toMatchObject({
      ok: false,
      code: VOICE_ENROLLMENT_SHORT_SPEECH,
      speakerDurationsMs: { 0: 5_000 },
    });
  });
});

describe('enrollVoiceProfile', () => {
  it('rejects without consent before processing recordings', async () => {
    const { deps, calls } = makeDeps();

    await expect(
      enrollVoiceProfile({ ...enrollInput, consentAccepted: false }, deps),
    ).rejects.toMatchObject({
      code: VOICE_ENROLLMENT_CONSENT_REQUIRED,
    });

    expect(calls.analyze).toEqual([]);
    expect(calls.diarize).toEqual([]);
    expect(calls.createSpeakerProfile).toEqual([]);
  });

  it.each([
    ['no speech', { ...passingAnalysis, noSpeechLikely: true }, VOICE_ENROLLMENT_NO_SPEECH],
    [
      'low speech ratio',
      { ...passingAnalysis, speechRatio: 0.1 },
      VOICE_ENROLLMENT_LOW_SPEECH_RATIO,
    ],
    ['low SNR', { ...passingAnalysis, peakDb: -20, noiseFloorDb: -30 }, VOICE_ENROLLMENT_LOW_SNR],
  ])('rejects %s enrollment analysis', async (_name, analysis, code) => {
    const { deps } = makeDeps({ analysis });

    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toMatchObject({
      code,
    });
  });

  it('enrolls when VAD undercounts but diarization confirms enough single-speaker speech', async () => {
    const { deps } = makeDeps({
      analysis: { ...passingAnalysis, speechActivityMs: 5_000 },
      diarization: diarization({
        segments: [{ start: 0, end: 12, speakerId: 0 }],
      }),
    });

    await expect(enrollVoiceProfile(enrollInput, deps)).resolves.toMatchObject({
      embedding: [1, 0],
      sampleCount: 1,
    });
  });

  it('rejects short enrollment when VAD and diarization are both below the duration floor', async () => {
    const { deps } = makeDeps({
      analysis: { ...passingAnalysis, speechActivityMs: 5_000 },
      diarization: diarization({
        segments: [{ start: 0, end: 5, speakerId: 0 }],
      }),
    });

    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toMatchObject({
      code: VOICE_ENROLLMENT_SHORT_SPEECH,
    });
  });

  it('rejects low speech-ratio analysis before calling the diarizer', async () => {
    const { deps, calls } = makeDeps({
      analysis: { ...passingAnalysis, speechRatio: 0.1 },
      diarization: () => {
        throw new Error('diarizer should not run');
      },
    });

    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toMatchObject({
      code: VOICE_ENROLLMENT_LOW_SPEECH_RATIO,
    });
    expect(calls.diarize).toEqual([]);
  });

  it('wraps transcode failures before analysis', async () => {
    const { deps, calls } = makeDeps({
      transcodeError: new Error('Exception in HostFunction: unordered_map::at: key not found'),
    });

    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toMatchObject({
      code: VOICE_ENROLLMENT_TRANSCODE_FAILED,
    });
    expect(calls.analyze).toEqual([]);
    expect(calls.diarize).toEqual([]);
  });

  it('wraps speech analysis failures before diarization', async () => {
    const { deps, calls } = makeDeps({
      analysisError: new Error('Exception in HostFunction: unordered_map::at: key not found'),
    });

    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toMatchObject({
      code: VOICE_ENROLLMENT_SPEECH_ANALYSIS_FAILED,
    });
    expect(calls.diarize).toEqual([]);
  });

  it('rejects invalid consent timestamps before processing recordings', async () => {
    const { deps, calls } = makeDeps();

    await expect(
      enrollVoiceProfile({ ...enrollInput, consentAcceptedAt: '2026-02-31T00:00:00.000Z' }, deps),
    ).rejects.toMatchObject({
      code: VOICE_ENROLLMENT_INVALID_CONSENT_TIMESTAMP,
    });

    expect(calls.analyze).toEqual([]);
    expect(calls.diarize).toEqual([]);
    expect(calls.createSpeakerProfile).toEqual([]);
  });

  it('requires a display name for non-owner enrollment before processing recordings', async () => {
    const { deps, calls } = makeDeps();

    await expect(
      enrollVoiceProfile({ ...enrollInput, isOwner: false, displayName: '   ' }, deps),
    ).rejects.toMatchObject({
      code: VOICE_ENROLLMENT_DISPLAY_NAME_REQUIRED,
    });

    expect(calls.analyze).toEqual([]);
    expect(calls.diarize).toEqual([]);
    expect(calls.createSpeakerProfile).toEqual([]);
  });

  it('calls diarizer with auto-count and never exact 1', async () => {
    const { deps, calls } = makeDeps();

    await enrollVoiceProfile(enrollInput, deps);

    expect(calls.diarize).toEqual([['file://take1.canonical.wav', 0]]);
    expect(calls.diarize[0][1]).not.toBe(1);
  });

  it('rejects two meaningful speakers above the duration floor', async () => {
    const { deps } = makeDeps({
      diarization: diarization({
        speakerCount: 2,
        segments: [
          { start: 0, end: 8, speakerId: 0 },
          { start: 8, end: 10, speakerId: 1 },
        ],
        embeddings: { 0: [1, 0], 1: [0, 1] },
      }),
    });

    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toMatchObject({
      code: VOICE_ENROLLMENT_MULTIPLE_SPEAKERS,
    });
  });

  it.each([
    ['zero embeddings', { 0: [0, 0] }, VOICE_ENROLLMENT_INVALID_EMBEDDING],
    ['non-finite embeddings', { 0: [Number.NaN, 1] }, VOICE_ENROLLMENT_INVALID_EMBEDDING],
    ['missing accepted-speaker embedding', {}, VOICE_ENROLLMENT_NO_USABLE_EMBEDDING],
  ])('rejects %s', async (_name, embeddings, code) => {
    const { deps } = makeDeps({ diarization: diarization({ embeddings }) });

    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toMatchObject({
      code,
    });
  });

  it('normalizes, averages, normalizes two accepted takes, and stores sampleCount=2', async () => {
    const { deps, calls } = makeDeps({
      diarization: (wavUri) =>
        diarization({
          embeddings: wavUri.includes('take2') ? { 0: [0, 5] } : { 0: [10, 0] },
        }),
    });

    const createdProfile = await enrollVoiceProfile(
      {
        ...enrollInput,
        recordings: [
          { uri: 'file://take1.wav', mimeType: 'audio/wav' },
          { uri: 'file://take2.m4a', mimeType: 'audio/mp4' },
        ],
        displayName: 'Alice',
        isOwner: false,
      },
      deps,
    );

    expect(createdProfile.embedding[0]).toBeCloseTo(Math.SQRT1_2);
    expect(createdProfile.embedding[1]).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(...createdProfile.embedding)).toBeCloseTo(1);
    expect(createdProfile.sampleCount).toBe(2);
    expect(calls.createSpeakerProfile).toEqual([
      expect.objectContaining({
        displayName: 'Alice',
        isOwner: 0,
        sampleCount: 2,
      }),
    ]);
    expect(calls.transcode).toEqual(['file://take1.wav', 'file://take2.m4a']);
    expect(calls.cleanup).toEqual([['file://take1.canonical.wav'], ['file://take2.canonical.wav']]);
  });

  it('owner enrollment writes isOwner=1, default name Me, and original consent timestamp', async () => {
    const { deps, calls } = makeDeps();
    const consentAcceptedAt = '2026-06-19T07:45:00.000Z';

    await enrollVoiceProfile({ ...enrollInput, consentAcceptedAt }, deps);

    expect(calls.createSpeakerProfile).toEqual([
      expect.objectContaining({
        displayName: 'Me',
        isOwner: 1,
        consentAt: consentAcceptedAt,
      }),
    ]);
  });

  it('wraps storage failures after extracting a usable embedding', async () => {
    const { deps } = makeDeps({
      createSpeakerProfile: () => {
        throw new Error('Exception in HostFunction: unordered_map::at: key not found');
      },
    });

    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toMatchObject({
      code: VOICE_ENROLLMENT_STORAGE_FAILED,
    });
  });

  it('returns a typed UI-actionable owner-already-exists error from the repository boundary', async () => {
    const existingOwnerError = new SpeakerProfileOwnerAlreadyExistsError();
    const { deps } = makeDeps({
      createSpeakerProfile: jest.fn(() => {
        throw existingOwnerError;
      }),
    });

    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toBe(existingOwnerError);
    await expect(enrollVoiceProfile(enrollInput, deps)).rejects.toMatchObject({
      code: 'SPEAKER_PROFILE_OWNER_ALREADY_EXISTS',
    });
  });
});

describe('extractEnrollmentEmbedding', () => {
  it('surfaces quality failures as VoiceEnrollmentError instances', async () => {
    const { deps } = makeDeps({ diarization: diarization({ embeddings: { 0: [0, 0] } }) });

    await expect(
      extractEnrollmentEmbedding({ recordings: [{ uri: 'file://take1.wav' }] }, deps),
    ).rejects.toBeInstanceOf(VoiceEnrollmentError);
  });
});

describe('identifyNoteSpeakers', () => {
  const makeIdentificationDeps = (
    overrides: {
      profiles?: SpeakerProfile[];
      speakers?: Speaker[];
    } = {},
  ) => {
    const calls: { updateSpeaker: Array<[number, Partial<Speaker>]> } = {
      updateSpeaker: [],
    };
    const deps: IdentifyNoteSpeakersDeps = {
      repo: {
        getSpeakerProfiles: () => overrides.profiles ?? [profile()],
        getSpeakers: () => overrides.speakers ?? [speaker()],
        updateSpeaker: (id, patch) => {
          calls.updateSpeaker.push([id, patch]);
        },
      },
    };
    return { deps, calls };
  };

  it('auto-labels a high-confidence unlocked speaker and sets profileId', () => {
    const { deps, calls } = makeIdentificationDeps();

    const result = identifyNoteSpeakers(7, { speaker_0: [1, 0] }, deps);

    expect(calls.updateSpeaker).toEqual([
      [
        100,
        {
          displayName: 'Alice',
          speakerStatus: 'confirmed',
          speakerLocked: 0,
          speakerLockSource: null,
          profileId: 10,
        },
      ],
    ]);
    expect(result.updatedSpeakerIds).toEqual([100]);
    expect(result.decisions).toEqual([
      { speakerId: 100, speakerLabel: 'speaker_0', decision: 'auto', profileId: 10 },
    ]);
  });

  it('creates a suggestion for a mid-confidence profile match', () => {
    const { deps, calls } = makeIdentificationDeps();

    const result = identifyNoteSpeakers(7, { speaker_0: [0.6, 0.8] }, deps);

    expect(calls.updateSpeaker).toEqual([
      [
        100,
        {
          displayName: 'Alice',
          speakerStatus: 'suggested',
          speakerLocked: 0,
          speakerLockSource: null,
          profileId: 10,
        },
      ],
    ]);
    expect(result.updatedSpeakerIds).toEqual([100]);
    expect(result.decisions).toEqual([
      { speakerId: 100, speakerLabel: 'speaker_0', decision: 'suggest', profileId: 10 },
    ]);
  });

  it('does not identify from attendee email alone when voiceprint confidence is low', () => {
    const { deps, calls } = makeIdentificationDeps({
      profiles: [profile({ id: 10, email: 'alice@example.com', embedding: [1, 0] })],
    });

    const result = identifyNoteSpeakers(7, { speaker_0: [0, 1] }, deps, {
      preferredProfileEmails: ['alice@example.com'],
    });

    expect(calls.updateSpeaker).toEqual([]);
    expect(result.decisions).toEqual([
      { speakerId: 100, speakerLabel: 'speaker_0', decision: 'none', profileId: null },
    ]);
  });

  it('falls back to all enrolled profiles when attendee email candidates do not match', () => {
    const { deps, calls } = makeIdentificationDeps({
      profiles: [
        profile({ id: 10, email: 'alice@example.com', embedding: [0, 1] }),
        profile({ id: 11, displayName: 'Carol', email: 'carol@example.com', embedding: [1, 0] }),
      ],
    });

    const result = identifyNoteSpeakers(7, { speaker_0: [1, 0] }, deps, {
      preferredProfileEmails: ['alice@example.com'],
    });

    expect(calls.updateSpeaker).toEqual([
      [
        100,
        {
          displayName: 'Carol',
          speakerStatus: 'confirmed',
          speakerLocked: 0,
          speakerLockSource: null,
          profileId: 11,
        },
      ],
    ]);
    expect(result.decisions).toEqual([
      { speakerId: 100, speakerLabel: 'speaker_0', decision: 'auto', profileId: 11 },
    ]);
  });

  it('leaves a locked speaker unchanged', () => {
    const { deps, calls } = makeIdentificationDeps({
      speakers: [
        speaker({
          displayName: 'Locked Alice',
          profileId: 99,
          speakerStatus: 'locked',
          speakerLocked: 1,
          speakerLockSource: 'user',
        }),
      ],
    });

    const result = identifyNoteSpeakers(7, { speaker_0: [1, 0] }, deps);

    expect(calls.updateSpeaker).toEqual([]);
    expect(result.updatedSpeakerIds).toEqual([]);
    expect(result.decisions).toEqual([
      { speakerId: 100, speakerLabel: 'speaker_0', decision: 'auto', profileId: 10 },
    ]);
  });

  it('ignores orphan embedding keys with no persisted speaker row', () => {
    const { deps, calls } = makeIdentificationDeps({ speakers: [] });

    const result = identifyNoteSpeakers(7, { speaker_9: [1, 0] }, deps);

    expect(calls.updateSpeaker).toEqual([]);
    expect(result).toEqual({ decisions: [], updatedSpeakerIds: [] });
  });

  it('leaves speaker rows without a matching embedding unchanged', () => {
    const { deps, calls } = makeIdentificationDeps({ speakers: [speaker()] });

    const result = identifyNoteSpeakers(7, {}, deps);

    expect(calls.updateSpeaker).toEqual([]);
    expect(result).toEqual({ decisions: [], updatedSpeakerIds: [] });
  });
});
