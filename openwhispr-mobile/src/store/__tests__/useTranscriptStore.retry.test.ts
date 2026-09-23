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
const mockProcessingModeState = { activeMode: 'cloud' as 'cloud' | 'private' };

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
    useTranscriptStore.setState({ transcripts: [failedTranscript({ requestContext: 'file' })] });
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

    await useTranscriptStore.getState().addTranscript({
      id: 'not-persisted',
      text: 'accepted transcript',
      provider: 'cloud',
      requestContext: 'recording',
    });

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
