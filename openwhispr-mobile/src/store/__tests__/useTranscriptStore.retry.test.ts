const mockListPendingProviderRecoveryJobs = jest.fn((): unknown[] => []);
const mockClearKeyboardProviderRecovery = jest.fn();
jest.mock('@/lib/keyboardInferenceRoute', () => ({
  listPendingProviderRecoveryJobs: mockListPendingProviderRecoveryJobs,
  clearKeyboardProviderRecovery: mockClearKeyboardProviderRecovery,
}));
const mockAppGroupGetItem = jest.fn((_key: string): string | null => null);
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { getItem: mockAppGroupGetItem },
}));
const mockSaveTranscripts = jest.fn();
const mockGetTranscripts = jest.fn();
const mockClearTranscripts = jest.fn();
const mockTranscribeAndCleanup = jest.fn();
const mockAudioToolsCleanup = jest.fn();
const mockTranscodeToWav = jest.fn();
const mockRetainTranscriptAudio = jest.fn();
const mockTranscriptAudioExists = jest.fn();
const mockDeleteManagedTranscriptAudio = jest.fn();
const mockGarbageCollectTranscriptAudio = jest.fn();
const mockIsManagedTranscriptAudioUri = jest.fn();
const mockIsWavAudioFile = jest.fn();
const mockLogTranscriptionCompleted = jest.fn();
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const mockProcessingModeState = { activeMode: 'cloud' as 'cloud' | 'private' | 'providers' };
const mockSnapshotTranscriptionJob = jest.fn();
jest.mock('@/lib/inferenceRouting', () => ({
  ...jest.requireActual('@/lib/inferenceRouting'),
  snapshotTranscriptionJob: (scope: string): unknown => mockSnapshotTranscriptionJob(scope),
}));

jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    getTranscripts: mockGetTranscripts,
    saveTranscripts: mockSaveTranscripts,
    clearTranscripts: mockClearTranscripts,
  },
}));

jest.mock('@/lib/transcribeAndCleanup', () => ({
  transcribeAndCleanup: mockTranscribeAndCleanup,
}));

jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: () => 'en',
}));

jest.mock('@/lib/transcriptAudio', () => ({
  __esModule: true,
  retainTranscriptAudio: mockRetainTranscriptAudio,
  transcriptAudioExists: mockTranscriptAudioExists,
  deleteManagedTranscriptAudio: mockDeleteManagedTranscriptAudio,
  garbageCollectTranscriptAudio: mockGarbageCollectTranscriptAudio,
  isManagedTranscriptAudioUri: mockIsManagedTranscriptAudioUri,
  isWavAudioFile: mockIsWavAudioFile,
  RETAINED_AUDIO_MAX_AGE_MS: TWO_DAYS_MS,
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: {
    getState: () => mockProcessingModeState,
  },
}));

jest.mock('@/lib/appsflyer', () => ({
  logTranscriptionCompleted: mockLogTranscriptionCompleted,
}));

jest.mock('../../../modules/audio-tools/src', () => ({
  AudioTools: {
    isAvailable: jest.fn(() => true),
    transcodeToWav: mockTranscodeToWav,
    cleanup: mockAudioToolsCleanup,
  },
}));

import type { Transcript } from '@/types';
import { withActiveProviderJob } from '@/lib/providerJobActivity';

const { useTranscriptStore } =
  require('../useTranscriptStore') as typeof import('../useTranscriptStore');

const failedTranscript = (overrides: Partial<Transcript> = {}): Transcript => ({
  id: 't1',
  text: '',
  createdAt: 100,
  updatedAt: 100,
  audioUrl: 'file://docs/transcript-audio/t1.m4a',
  audioFileName: 'clip.m4a',
  audioMimeType: 'audio/m4a',
  provider: 'cloud',
  status: 'failed',
  errorMessage: 'network down',
  requestContext: 'keyboard',
  keyboardTone: 'formal',
  jobId: 'job-1',
  retryCount: 0,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockListPendingProviderRecoveryJobs.mockReturnValue([]);
  mockAppGroupGetItem.mockReturnValue(null);
  mockProcessingModeState.activeMode = 'cloud';
  mockTranscribeAndCleanup.mockResolvedValue({
    text: 'clean transcript',
    originalText: 'raw transcript',
    transcription: { text: 'raw transcript', duration: 3, provider: 'cloud' },
    cleanupApplied: true,
    fusedCleanup: false,
  });
  mockTranscodeToWav.mockResolvedValue({ uri: 'file://tmp/retry.wav', durationMs: 3000 });
  mockAudioToolsCleanup.mockResolvedValue(undefined);
  mockRetainTranscriptAudio.mockImplementation(
    (_sourceUri, input: { transcriptId: string }) =>
      `file://docs/transcript-audio/${input.transcriptId}.m4a`,
  );
  mockTranscriptAudioExists.mockResolvedValue(true);
  mockDeleteManagedTranscriptAudio.mockResolvedValue(undefined);
  mockGarbageCollectTranscriptAudio.mockResolvedValue(undefined);
  mockIsManagedTranscriptAudioUri.mockImplementation((uri?: string) =>
    uri?.startsWith('file://docs/transcript-audio/'),
  );
  mockIsWavAudioFile.mockReturnValue(false);
  mockSaveTranscripts.mockResolvedValue(undefined);
  mockClearTranscripts.mockResolvedValue(undefined);
  mockGetTranscripts.mockResolvedValue([]);
  useTranscriptStore.setState({
    transcripts: [],
    currentTranscript: null,
    isLoading: false,
    isLoaded: true,
    error: null,
  });
});

describe('useTranscriptStore retry support', () => {
  it('adds a failed transcript with retained audio metadata', async () => {
    await useTranscriptStore.getState().addFailedTranscript({
      id: 't1',
      audioUrl: 'file://tmp/source.m4a',
      audioFileName: 'source.m4a',
      audioMimeType: 'audio/m4a',
      provider: 'cloud',
      requestContext: 'keyboard',
      keyboardTone: 'formal',
      jobId: 'job-1',
      errorMessage: 'network down',
    });

    expect(mockRetainTranscriptAudio).toHaveBeenCalledWith('file://tmp/source.m4a', {
      transcriptId: 't1',
      audioFileName: 'source.m4a',
      audioMimeType: 'audio/m4a',
    });
    expect(useTranscriptStore.getState().transcripts).toEqual([
      expect.objectContaining({
        id: 't1',
        status: 'failed',
        errorMessage: 'network down',
        requestContext: 'keyboard',
        audioUrl: 'file://docs/transcript-audio/t1.m4a',
      }),
    ]);
  });

  it('retries a failed transcript and updates the same row on success', async () => {
    useTranscriptStore.setState({ transcripts: [failedTranscript()] });

    const updated = await useTranscriptStore.getState().retryTranscript('t1');

    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        audioUri: 'file://docs/transcript-audio/t1.m4a',
        provider: 'cloud',
        requestContext: 'keyboard',
        keyboardTone: 'formal',
        language: 'en',
      }),
    );
    expect(updated).toEqual(
      expect.objectContaining({
        id: 't1',
        text: 'clean transcript',
        originalText: 'raw transcript',
        status: 'completed',
        errorMessage: undefined,
        retryCount: 1,
      }),
    );
    expect(useTranscriptStore.getState().transcripts).toHaveLength(1);
    expect(mockLogTranscriptionCompleted).toHaveBeenCalledWith({
      source: 'keyboard',
      provider: 'cloud',
    });
  });

  it('releases the retained audio when a retry succeeds', async () => {
    useTranscriptStore.setState({ transcripts: [failedTranscript()] });

    const updated = await useTranscriptStore.getState().retryTranscript('t1');

    expect(mockDeleteManagedTranscriptAudio).toHaveBeenCalledWith(
      'file://docs/transcript-audio/t1.m4a',
    );
    expect(updated.audioUrl).toBeUndefined();
    expect(useTranscriptStore.getState().transcripts[0].audioUrl).toBeUndefined();
  });

  it('does not release the retained audio when a retry fails', async () => {
    useTranscriptStore.setState({ transcripts: [failedTranscript()] });
    mockTranscribeAndCleanup.mockRejectedValueOnce(new Error('still offline'));

    await expect(useTranscriptStore.getState().retryTranscript('t1')).rejects.toThrow(
      'still offline',
    );

    expect(mockDeleteManagedTranscriptAudio).not.toHaveBeenCalled();
    expect(useTranscriptStore.getState().transcripts[0].audioUrl).toBe(
      'file://docs/transcript-audio/t1.m4a',
    );
    expect(mockLogTranscriptionCompleted).not.toHaveBeenCalled();
  });

  it('drops the audio when a failed row is upgraded via addTranscript', async () => {
    useTranscriptStore.setState({ transcripts: [failedTranscript()] });

    await useTranscriptStore.getState().addTranscript({
      id: 't1',
      text: 'recovered transcript',
      provider: 'cloud',
      audioUrl: 'file://docs/transcript-audio/t1.m4a',
      requestContext: 'keyboard',
    });

    expect(mockRetainTranscriptAudio).not.toHaveBeenCalled();
    expect(mockDeleteManagedTranscriptAudio).toHaveBeenCalledWith(
      'file://docs/transcript-audio/t1.m4a',
    );
    const [row] = useTranscriptStore.getState().transcripts;
    expect(row).toEqual(
      expect.objectContaining({ id: 't1', status: 'completed', audioUrl: undefined }),
    );
  });

  it('keeps the row failed with a friendly message when retry throws', async () => {
    useTranscriptStore.setState({ transcripts: [failedTranscript()] });
    mockTranscribeAndCleanup.mockRejectedValueOnce(
      new Error('Error Domain=NSURLErrorDomain Code=-1009 "offline"'),
    );

    await expect(useTranscriptStore.getState().retryTranscript('t1')).rejects.toThrow(
      'NSURLErrorDomain',
    );

    expect(useTranscriptStore.getState().transcripts[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'No internet connection. Check your connection and try again.',
        retryCount: 1,
      }),
    );
  });

  it('updates the row when retained audio is missing', async () => {
    useTranscriptStore.setState({ transcripts: [failedTranscript()] });
    mockTranscriptAudioExists.mockResolvedValueOnce(false);

    await expect(useTranscriptStore.getState().retryTranscript('t1')).rejects.toThrow(
      'Audio file not found',
    );

    expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
    expect(useTranscriptStore.getState().transcripts[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Audio file not found',
        retryCount: 1,
      }),
    );
  });

  it('transcodes compressed audio before local retry and cleans up the temp wav', async () => {
    mockProcessingModeState.activeMode = 'private';
    useTranscriptStore.setState({
      transcripts: [failedTranscript({ requestContext: 'file', provider: 'local' })],
    });
    mockTranscribeAndCleanup.mockResolvedValueOnce({
      text: 'clean transcript',
      originalText: 'raw transcript',
      transcription: { text: 'raw transcript', duration: 3, provider: 'local' },
      cleanupApplied: true,
      fusedCleanup: false,
    });

    await useTranscriptStore.getState().retryTranscript('t1');

    expect(mockTranscodeToWav).toHaveBeenCalledWith('file://docs/transcript-audio/t1.m4a');
    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        audioUri: 'file://tmp/retry.wav',
        fileName: 't1-retry.wav',
        mimeType: 'audio/wav',
        provider: 'local',
        requestContext: 'file',
      }),
    );
    expect(mockAudioToolsCleanup).toHaveBeenCalledWith(['file://tmp/retry.wav']);
    expect(mockLogTranscriptionCompleted).toHaveBeenCalledWith({
      source: 'file',
      provider: 'local',
    });
  });
});

describe('useTranscriptStore first-pass AppsFlyer events', () => {
  it.each([
    { source: 'keyboard' as const, provider: 'cloud' as const },
    { source: 'recording' as const, provider: 'local' as const },
    { source: 'file' as const, provider: 'cloud' as const },
  ])(
    'logs a persisted $source transcription completed by $provider',
    async ({ source, provider }) => {
      await useTranscriptStore.getState().addTranscript({
        id: `${source}-${provider}`,
        text: 'accepted transcript',
        provider,
        requestContext: source,
      });

      expect(mockSaveTranscripts).toHaveBeenCalledTimes(1);
      expect(mockLogTranscriptionCompleted).toHaveBeenCalledWith({ source, provider });
    },
  );

  it('does not log an empty completed transcript or a persisted failed transcript', async () => {
    await useTranscriptStore.getState().addTranscript({
      id: 'empty',
      text: '   ',
      provider: 'local',
      requestContext: 'recording',
    });
    await useTranscriptStore.getState().addFailedTranscript({
      id: 'failed',
      audioUrl: 'file://tmp/source.m4a',
      provider: 'cloud',
      requestContext: 'file',
      errorMessage: 'cancelled',
    });

    expect(mockLogTranscriptionCompleted).not.toHaveBeenCalled();
  });

  it('does not log when completed transcript persistence fails', async () => {
    mockSaveTranscripts.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(
      useTranscriptStore.getState().addTranscript({
        id: 'not-persisted',
        text: 'accepted transcript',
        provider: 'cloud',
        requestContext: 'recording',
      }),
    ).rejects.toThrow('storage unavailable');

    expect(mockLogTranscriptionCompleted).not.toHaveBeenCalled();
  });

  it('does not log an empty successful retry', async () => {
    useTranscriptStore.setState({ transcripts: [failedTranscript()] });
    mockTranscribeAndCleanup.mockResolvedValueOnce({
      text: '   ',
      originalText: '',
      transcription: { text: '', duration: 0, provider: 'cloud' },
      cleanupApplied: false,
      fusedCleanup: false,
    });

    await useTranscriptStore.getState().retryTranscript('t1');

    expect(mockLogTranscriptionCompleted).not.toHaveBeenCalled();
  });
});

describe('useTranscriptStore audio retention on load', () => {
  it('expires retained audio for a failed row past the retention window', async () => {
    const stale = failedTranscript({
      id: 'stale',
      updatedAt: Date.now() - TWO_DAYS_MS - 1000,
    });
    mockGetTranscripts.mockResolvedValueOnce([stale]);

    await useTranscriptStore.getState().loadTranscripts();

    const [row] = useTranscriptStore.getState().transcripts;
    expect(row).toEqual(
      expect.objectContaining({ id: 'stale', status: 'failed', audioUrl: undefined }),
    );
    // Persisted, and the GC keeps nothing (the expired uri was dropped).
    expect(mockSaveTranscripts).toHaveBeenCalled();
    expect(mockGarbageCollectTranscriptAudio).toHaveBeenCalledWith([]);
  });

  it('keeps recent failed audio and hands it to the garbage collector', async () => {
    const recent = failedTranscript({ id: 'recent', updatedAt: Date.now() });
    mockGetTranscripts.mockResolvedValueOnce([recent]);

    await useTranscriptStore.getState().loadTranscripts();

    const [row] = useTranscriptStore.getState().transcripts;
    expect(row.audioUrl).toBe('file://docs/transcript-audio/t1.m4a');
    expect(mockSaveTranscripts).not.toHaveBeenCalled();
    expect(mockGarbageCollectTranscriptAudio).toHaveBeenCalledWith([
      'file://docs/transcript-audio/t1.m4a',
    ]);
  });

  it('garbage collects orphaned audio for completed rows (no retained uri)', async () => {
    const completed = failedTranscript({
      id: 'done',
      status: 'completed',
      audioUrl: undefined,
    });
    mockGetTranscripts.mockResolvedValueOnce([completed]);

    await useTranscriptStore.getState().loadTranscripts();

    expect(mockGarbageCollectTranscriptAudio).toHaveBeenCalledWith([]);
  });
});

describe('BYOK retry destination', () => {
  const route = {
    mode: 'providers',
    scope: 'dictation',
    providerId: 'groq',
    modelId: 'whisper-large-v3-turbo',
    endpoint: 'https://api.groq.com/openai/v1',
    credentialRef: 'provider.groq',
  } as const;
  it('keeps the original provider route when current mode is Cloud', async () => {
    useTranscriptStore.setState({
      transcripts: [failedTranscript({ provider: 'byok', inferenceRoute: route })],
    });
    await useTranscriptStore.getState().retryTranscript('t1');
    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'byok', inferenceRoute: route }),
    );
  });
  it('refuses a BYOK retry without its original route', async () => {
    useTranscriptStore.setState({ transcripts: [failedTranscript({ provider: 'byok' })] });
    await expect(useTranscriptStore.getState().retryTranscript('t1')).rejects.toThrow(
      'original provider',
    );
    expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
  });
});

it('retains text-stage routes on failed rows and passes them unchanged to retry', async () => {
  const cleanupRoute = { mode: 'openwhispr' as const, scope: 'cleanup' as const };
  const agentRoute = { mode: 'local' as const, scope: 'agent' as const };
  await useTranscriptStore.getState().addFailedTranscript({
    id: 'stage-retry',
    errorMessage: 'failed',
    audioUrl: 'file://docs/transcript-audio/stage-retry.m4a',
    provider: 'cloud',
    cleanupRoute,
    agentRoute,
    agentUnavailable: 'Agent unavailable.',
  });
  await useTranscriptStore.getState().retryTranscript('stage-retry');
  expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({ cleanupRoute, agentRoute, agentUnavailable: 'Agent unavailable.' }),
  );
});

it('retries a Cloud recording on-device after switching to private mode', async () => {
  mockProcessingModeState.activeMode = 'private';
  useTranscriptStore.setState({
    transcripts: [failedTranscript({ cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' } })],
  });
  await useTranscriptStore.getState().retryTranscript('t1');
  expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'local',
      cleanupRoute: { mode: 'local', scope: 'cleanup' },
    }),
  );
});

it('retries an On-Device recording on Cloud after switching to Cloud', async () => {
  useTranscriptStore.setState({
    transcripts: [
      failedTranscript({ provider: 'local', cleanupRoute: { mode: 'local', scope: 'cleanup' } }),
    ],
  });
  await useTranscriptStore.getState().retryTranscript('t1');
  expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'cloud',
      cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
    }),
  );
});

it('saves the rerouted text routes when a rerouted retry fails', async () => {
  useTranscriptStore.setState({
    transcripts: [
      failedTranscript({ provider: 'local', cleanupRoute: { mode: 'local', scope: 'cleanup' } }),
    ],
  });
  mockTranscribeAndCleanup.mockRejectedValueOnce(new Error('network down'));
  await expect(useTranscriptStore.getState().retryTranscript('t1')).rejects.toThrow();
  expect(useTranscriptStore.getState().transcripts[0]).toMatchObject({
    provider: 'cloud',
    cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
  });
});

it('clears the recovery entry a retry creates, whether it succeeds or fails', async () => {
  useTranscriptStore.setState({ transcripts: [failedTranscript()] });
  await useTranscriptStore.getState().retryTranscript('t1');
  mockTranscribeAndCleanup.mockRejectedValueOnce(new Error('network down'));
  useTranscriptStore.setState({ transcripts: [failedTranscript()] });
  await expect(useTranscriptStore.getState().retryTranscript('t1')).rejects.toThrow();
  const retryJobIds = mockTranscribeAndCleanup.mock.calls.map(([request]) => request.jobId);
  expect(retryJobIds).toHaveLength(2);
  for (const jobId of retryJobIds) {
    expect(mockClearKeyboardProviderRecovery).toHaveBeenCalledWith(jobId);
  }
});

it('does not send a provider recording anywhere while private mode is on', async () => {
  mockProcessingModeState.activeMode = 'private';
  useTranscriptStore.setState({
    transcripts: [
      failedTranscript({
        provider: 'byok',
        inferenceRoute: {
          mode: 'providers',
          scope: 'dictation',
          providerId: 'groq',
          modelId: 'whisper-large-v3-turbo',
          endpoint: 'https://api.groq.com/openai/v1',
        },
      }),
    ],
  });
  await expect(useTranscriptStore.getState().retryTranscript('t1')).rejects.toThrow(
    'original route',
  );
  expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
});

it('reports a failed durable history write so keyboard recovery keeps its data', async () => {
  mockSaveTranscripts.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(
    useTranscriptStore.getState().addTranscript({ id: 'recovery', text: 'raw', provider: 'byok' }),
  ).rejects.toThrow('disk unavailable');
  expect(mockDeleteManagedTranscriptAudio).not.toHaveBeenCalled();
});
it('keeps native provider recovery audio during startup garbage collection', async () => {
  mockGetTranscripts.mockResolvedValueOnce([]);
  mockAppGroupGetItem.mockImplementation((key: string) =>
    key === 'keyboard_recording_job_id'
      ? 'interrupted'
      : key === 'keyboard_upload_audio.interrupted'
        ? 'file://docs/transcript-audio/pending.m4a'
        : null,
  );
  await useTranscriptStore.getState().loadTranscripts();
  expect(mockGarbageCollectTranscriptAudio).toHaveBeenCalledWith([
    'file://docs/transcript-audio/pending.m4a',
  ]);
});

describe('durable provider recovery across all jobs', () => {
  const route = {
    provider: 'byok',
    inferenceRoute: {
      mode: 'providers',
      scope: 'upload',
      providerId: 'groq',
      modelId: 'whisper-large-v3-turbo',
      endpoint: 'https://api.groq.com/openai/v1',
      credentialRef: 'provider.groq',
    },
    cleanupRoute: { mode: 'local', scope: 'cleanup' },
  } as const;

  it('recovers superseded raw results and interrupted uploads using original routes', async () => {
    mockGetTranscripts.mockResolvedValueOnce([]);
    mockListPendingProviderRecoveryJobs.mockReturnValue([
      { jobId: 'raw-job', route, requestContext: 'file', result: { text: 'durable raw', route } },
      {
        jobId: 'pending-job',
        route,
        requestContext: 'file',
        audioUri: 'file://docs/transcript-audio/pending.m4a',
      },
    ]);
    await useTranscriptStore.getState().loadTranscripts();
    expect(useTranscriptStore.getState().transcripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'raw-job',
          status: 'completed',
          text: 'durable raw',
          ...route,
          cleanupWarning: expect.any(String),
        }),
        expect.objectContaining({
          id: 'pending-job',
          status: 'failed',
          ...route,
          requestContext: 'file',
          audioUrl: 'file://docs/transcript-audio/pending.m4a',
        }),
      ]),
    );
    expect(mockClearKeyboardProviderRecovery).toHaveBeenCalledTimes(2);
    expect(mockSaveTranscripts.mock.invocationCallOrder[0]).toBeLessThan(
      mockClearKeyboardProviderRecovery.mock.invocationCallOrder[0],
    );
    expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
  });

  it('keeps pending recovery data if saving history fails', async () => {
    mockGetTranscripts.mockResolvedValueOnce([]);
    mockListPendingProviderRecoveryJobs.mockReturnValue([
      { jobId: 'raw-job', route, result: { text: 'durable raw', route } },
    ]);
    mockSaveTranscripts.mockRejectedValueOnce(new Error('disk full'));
    await useTranscriptStore.getState().loadTranscripts();
    expect(mockClearKeyboardProviderRecovery).not.toHaveBeenCalled();
    expect(mockGarbageCollectTranscriptAudio).not.toHaveBeenCalled();
  });

  it('preserves corrupt and active keyboard jobs without inserting duplicate history', async () => {
    mockGetTranscripts.mockResolvedValueOnce([]);
    mockAppGroupGetItem.mockImplementation((key: string) =>
      key === 'keyboard_recording_job_id' ? 'active' : null,
    );
    mockListPendingProviderRecoveryJobs.mockReturnValue([
      {
        jobId: 'active',
        route,
        result: { text: 'keyboard raw', route },
        audioUri: 'file://docs/transcript-audio/active.m4a',
      },
      {
        jobId: 'corrupt',
        error: 'Invalid route',
        audioUri: 'file://docs/transcript-audio/corrupt.m4a',
      },
    ]);
    await useTranscriptStore.getState().loadTranscripts();
    expect(useTranscriptStore.getState().transcripts).toEqual([]);
    expect(mockClearKeyboardProviderRecovery).not.toHaveBeenCalled();
    expect(mockGarbageCollectTranscriptAudio).toHaveBeenCalledWith(
      expect.arrayContaining([
        'file://docs/transcript-audio/active.m4a',
        'file://docs/transcript-audio/corrupt.m4a',
      ]),
    );
  });
});

it('does not recover or clear a provider job still running during startup hydration', async () => {
  mockGetTranscripts.mockResolvedValueOnce([]);
  mockListPendingProviderRecoveryJobs.mockReturnValue([
    {
      jobId: 'running',
      route: { provider: 'byok' },
      audioUri: 'file://docs/transcript-audio/running.m4a',
    },
  ]);
  await withActiveProviderJob('running', () => useTranscriptStore.getState().loadTranscripts());
  expect(useTranscriptStore.getState().transcripts).toEqual([]);
  expect(mockClearKeyboardProviderRecovery).not.toHaveBeenCalled();
  expect(mockGarbageCollectTranscriptAudio).toHaveBeenCalledWith([
    'file://docs/transcript-audio/running.m4a',
  ]);
});

describe('saving before history has loaded', () => {
  const stored = [
    failedTranscript({ id: 'old-1', status: 'completed', audioUrl: undefined }),
    failedTranscript({ id: 'old-2', status: 'completed', audioUrl: undefined }),
  ];
  beforeEach(() => {
    useTranscriptStore.setState({ transcripts: [], isLoaded: false });
    mockGetTranscripts.mockResolvedValue(stored);
  });

  it('keeps stored history when a failed row is saved before the first load', async () => {
    await useTranscriptStore.getState().addFailedTranscript({
      id: 'recovered',
      audioUrl: 'file://tmp/source.m4a',
      provider: 'byok',
      errorMessage: 'interrupted',
    });
    const saved = mockSaveTranscripts.mock.calls.at(-1)?.[0] as Transcript[];
    expect(saved.map((row) => row.id)).toEqual(['old-1', 'old-2', 'recovered']);
  });

  it('keeps stored history when a completed row is saved before the first load', async () => {
    await useTranscriptStore
      .getState()
      .addTranscript({ id: 'recovered', text: 'raw', provider: 'cloud' });
    const saved = mockSaveTranscripts.mock.calls.at(-1)?.[0] as Transcript[];
    expect(saved.map((row) => row.id)).toEqual(['old-1', 'old-2', 'recovered']);
  });

  it('shares one storage read between a concurrent load and an early save', async () => {
    await Promise.all([
      useTranscriptStore.getState().loadTranscripts(),
      useTranscriptStore.getState().addTranscript({ id: 'new', text: 'raw', provider: 'cloud' }),
    ]);
    expect(mockGetTranscripts).toHaveBeenCalledTimes(1);
    expect(useTranscriptStore.getState().transcripts.map((row) => row.id)).toEqual([
      'old-1',
      'old-2',
      'new',
    ]);
  });

  it('refuses to overwrite history it could not read', async () => {
    mockGetTranscripts.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(
      useTranscriptStore.getState().addTranscript({ id: 'new', text: 'raw', provider: 'cloud' }),
    ).rejects.toThrow();
    expect(mockSaveTranscripts).not.toHaveBeenCalled();
  });
});

describe('a reload while a write is in progress', () => {
  it('never collects audio that a failed row is about to point at', async () => {
    useTranscriptStore.setState({ transcripts: [], isLoaded: true });
    let stored: Transcript[] = [];
    mockGetTranscripts.mockImplementation(async () => stored);
    mockSaveTranscripts.mockImplementation(async (rows: Transcript[]) => {
      stored = rows;
    });
    let finishRetain!: (uri: string) => void;
    mockRetainTranscriptAudio.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetain = resolve;
        }),
    );
    const write = useTranscriptStore.getState().addFailedTranscript({
      id: 'new',
      audioUrl: 'file://tmp/source.m4a',
      provider: 'cloud',
      errorMessage: 'network down',
    });
    for (let index = 0; index < 10 && !finishRetain; index++) await Promise.resolve();
    const reload = useTranscriptStore.getState().loadTranscripts();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    finishRetain('file://docs/transcript-audio/new.m4a');
    await Promise.all([write, reload]);
    for (const [keepUris] of mockGarbageCollectTranscriptAudio.mock.calls) {
      expect(keepUris).toContain('file://docs/transcript-audio/new.m4a');
    }
    expect(mockGarbageCollectTranscriptAudio).toHaveBeenCalled();
  });
});

describe('a write during a reload', () => {
  it('keeps the written row when the reload read storage before the write', async () => {
    useTranscriptStore.setState({ transcripts: [], isLoaded: true });
    let finishRead!: (rows: Transcript[]) => void;
    mockGetTranscripts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const reload = useTranscriptStore.getState().loadTranscripts();
    for (let index = 0; index < 10 && !finishRead; index++) await Promise.resolve();
    const write = useTranscriptStore
      .getState()
      .addTranscript({ id: 'new', text: 'raw', provider: 'cloud' });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    finishRead([]);
    await Promise.all([reload, write]);
    expect(useTranscriptStore.getState().transcripts.map((row) => row.id)).toEqual(['new']);
  });
});

describe('recovering a retry that was killed mid-request', () => {
  const route = {
    provider: 'byok',
    inferenceRoute: {
      mode: 'providers',
      scope: 'dictation',
      providerId: 'groq',
      modelId: 'whisper-large-v3-turbo',
      endpoint: 'https://api.groq.com/openai/v1',
      credentialRef: 'provider.groq',
    },
  } as const;
  const original = (): Transcript =>
    failedTranscript({ id: 't1', jobId: 'job-1', provider: 'byok', updatedAt: Date.now() });

  it('completes the original row with the recovered text instead of adding a row', async () => {
    mockGetTranscripts.mockResolvedValueOnce([original()]);
    mockListPendingProviderRecoveryJobs.mockReturnValue([
      {
        jobId: 'job-1-retry-1700000000000',
        route,
        requestContext: 'keyboard',
        result: { text: 'recovered words', route },
        audioUri: 'file://docs/transcript-audio/t1.m4a',
      },
    ]);
    await useTranscriptStore.getState().loadTranscripts();
    const rows = useTranscriptStore.getState().transcripts;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 't1',
      status: 'completed',
      text: 'recovered words',
      audioUrl: undefined,
      errorMessage: undefined,
    });
    expect(mockClearKeyboardProviderRecovery).toHaveBeenCalledWith('job-1-retry-1700000000000');
    expect(mockGarbageCollectTranscriptAudio).toHaveBeenCalledWith([]);
  });

  it('keeps one failed row for an interrupted retry instead of two sharing its audio', async () => {
    mockGetTranscripts.mockResolvedValueOnce([original()]);
    mockListPendingProviderRecoveryJobs.mockReturnValue([
      {
        jobId: 'job-1-retry-1700000000000',
        route,
        requestContext: 'keyboard',
        audioUri: 'file://docs/transcript-audio/t1.m4a',
      },
    ]);
    await useTranscriptStore.getState().loadTranscripts();
    const rows = useTranscriptStore.getState().transcripts;
    expect(rows).toEqual([
      expect.objectContaining({
        id: 't1',
        status: 'failed',
        audioUrl: 'file://docs/transcript-audio/t1.m4a',
      }),
    ]);
    expect(mockClearKeyboardProviderRecovery).toHaveBeenCalledWith('job-1-retry-1700000000000');
    expect(mockGarbageCollectTranscriptAudio).toHaveBeenCalledWith([
      'file://docs/transcript-audio/t1.m4a',
    ]);
  });

  it('matches a retry of a row without a job id by the row id', async () => {
    mockGetTranscripts.mockResolvedValueOnce([{ ...original(), jobId: undefined }]);
    mockListPendingProviderRecoveryJobs.mockReturnValue([
      {
        jobId: 't1-retry-1700000000000',
        route,
        requestContext: 'recording',
        audioUri: 'file://docs/transcript-audio/t1.m4a',
      },
    ]);
    await useTranscriptStore.getState().loadTranscripts();
    expect(useTranscriptStore.getState().transcripts.map((row) => row.id)).toEqual(['t1']);
  });
});

describe('retry destination in Bring Your Own Key mode', () => {
  const currentRoute = {
    provider: 'byok',
    inferenceRoute: {
      mode: 'providers',
      scope: 'dictation',
      providerId: 'openai',
      modelId: 'gpt-4o-mini-transcribe',
      endpoint: 'https://api.openai.com/v1',
      credentialRef: 'provider.openai',
    },
    cleanupUnavailable: 'Choose a cleanup provider in AI Models. Your raw transcript is saved.',
  } as const;
  beforeEach(() => {
    mockProcessingModeState.activeMode = 'providers';
    mockSnapshotTranscriptionJob.mockReturnValue(currentRoute);
  });

  it('sends a Cloud recording to the current dictation provider, not back to Cloud', async () => {
    useTranscriptStore.setState({
      transcripts: [failedTranscript({ cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' } })],
    });
    await useTranscriptStore.getState().retryTranscript('t1');
    expect(mockSnapshotTranscriptionJob).toHaveBeenCalledWith('dictation');
    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'byok',
        inferenceRoute: currentRoute.inferenceRoute,
        cleanupRoute: undefined,
        cleanupUnavailable: currentRoute.cleanupUnavailable,
      }),
    );
  });

  it('follows the current upload choice for a Cloud file upload', async () => {
    mockSnapshotTranscriptionJob.mockReturnValue({
      provider: 'cloud',
      cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
    });
    useTranscriptStore.setState({
      transcripts: [failedTranscript({ provider: 'local', requestContext: 'file' })],
    });
    await useTranscriptStore.getState().retryTranscript('t1');
    expect(mockSnapshotTranscriptionJob).toHaveBeenCalledWith('upload');
    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'cloud', inferenceRoute: undefined }),
    );
  });

  it('keeps a provider recording on its original route', async () => {
    const original = {
      mode: 'providers',
      scope: 'dictation',
      providerId: 'groq',
      modelId: 'whisper-large-v3-turbo',
      endpoint: 'https://api.groq.com/openai/v1',
      credentialRef: 'provider.groq',
    } as const;
    useTranscriptStore.setState({
      transcripts: [failedTranscript({ provider: 'byok', inferenceRoute: original })],
    });
    await useTranscriptStore.getState().retryTranscript('t1');
    expect(mockSnapshotTranscriptionJob).not.toHaveBeenCalled();
    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'byok', inferenceRoute: original }),
    );
  });

  it('keeps a failed rerouted recording on its own route, so it follows the mode again', async () => {
    useTranscriptStore.setState({ transcripts: [failedTranscript()] });
    mockTranscribeAndCleanup.mockRejectedValueOnce(new Error('network down'));
    await expect(useTranscriptStore.getState().retryTranscript('t1')).rejects.toThrow();
    const saved = useTranscriptStore.getState().transcripts[0];
    expect(saved.provider).toBe(failedTranscript().provider);
    expect(saved.inferenceRoute).toBeUndefined();
    expect(saved.status).toBe('failed');

    mockProcessingModeState.activeMode = 'cloud';
    mockTranscribeAndCleanup.mockClear();
    await useTranscriptStore.getState().retryTranscript('t1');
    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'cloud', inferenceRoute: undefined }),
    );
  });
});
