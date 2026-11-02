jest.mock('@/lib/transcriptAudio.android', () => jest.requireMock('@/lib/transcriptAudio'));
import { Platform } from 'react-native';
import type { Transcript } from '@/types';
import type { TranscriptState } from '../createTranscriptStore';
import { useTranscriptStore as iosStore } from '../useTranscriptStore';
import { useTranscriptStore as androidStore } from '../useTranscriptStore.android';

const mockRead = jest.fn();
const mockSave = jest.fn();
const mockClear = jest.fn();
const mockTranscribe = jest.fn();
const mockRelease = jest.fn();
const mockCollect = jest.fn();
const mockMode = { activeMode: 'cloud' };
jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    getTranscripts: (...args: unknown[]) => mockRead(...args),
    saveTranscripts: (...args: unknown[]) => mockSave(...args),
    clearTranscripts: (...args: unknown[]) => mockClear(...args),
    getAllTranscriptAudio: () => [],
  },
}));
jest.mock('@/lib/transcriptScope', () => ({
  captureTranscriptScope: () => null,
  isTranscriptScopeCurrent: () => true,
  observeTranscriptScope: () => () => {},
}));
jest.mock('@/services/providers/NativeProviderTransport', () => ({
  abortError: (message: string) => Object.assign(new Error(message), { name: 'AbortError' }),
}));
jest.mock('@/lib/providerJobActivity', () => ({ isProviderJobActive: () => false }));
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { getItem: () => null },
}));
jest.mock('@/lib/keyboardInferenceRoute', () => ({
  listPendingProviderRecoveryJobs: () => [],
  clearKeyboardProviderRecovery: jest.fn(),
}));
jest.mock('../../../modules/audio-tools/src', () => ({
  AudioTools: { isAvailable: () => false, cleanup: async () => {} },
}));
jest.mock('@/lib/transcribeAndCleanup', () => ({
  transcribeAndCleanup: (...args: unknown[]) => mockTranscribe(...args),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: () => 'en' }));
jest.mock('@/lib/transcriptionErrors', () => ({
  toFriendlyTranscriptionErrorMessage: (error: Error) => error.message,
}));
jest.mock('@/lib/transcriptAudio', () => ({
  deleteManagedTranscriptAudio: async () => {},
  garbageCollectTranscriptAudio: (...args: unknown[]) => mockCollect(...args),
  isManagedTranscriptAudioUri: (uri: string) => !!uri,
  isWavAudioFile: () => true,
  retainTranscriptAudio: async (uri: string) => uri,
  releaseTranscriptAudio: (...args: unknown[]) => mockRelease(...args),
  RETAINED_AUDIO_MAX_AGE_MS: Number.MAX_SAFE_INTEGER,
  transcriptAudioExists: async () => true,
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => mockMode },
}));
jest.mock('@/lib/inferenceRouting', () => ({
  snapshotTextInference: () => ({}),
  snapshotTranscriptionJob: () => ({ provider: 'cloud' }),
}));
jest.mock('@/lib/appsflyer', () => ({ logTranscriptionCompleted: jest.fn() }));

const failed: Transcript = {
  id: 'fixture',
  text: '',
  createdAt: 100,
  updatedAt: 100,
  audioUrl: 'file://fixture.wav',
  provider: 'cloud',
  status: 'failed',
  errorMessage: 'Original failure',
  retryCount: 0,
  jobId: 'original-job',
};
const originalPlatform = Platform.OS;
afterAll(() => Object.defineProperty(Platform, 'OS', { value: originalPlatform }));

describe.each([
  { platform: 'ios', store: iosStore },
  { platform: 'android', store: androidStore },
])('$platform transcript boundary', ({ platform, store }) => {
  const setState = (state: Partial<TranscriptState>) => {
    if (platform === 'ios') iosStore.setState(state);
    else androidStore.setState(state);
  };
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { value: platform, configurable: true });
    mockMode.activeMode = 'cloud';
    mockRead.mockResolvedValue([]);
    mockSave.mockResolvedValue(undefined);
    mockClear.mockResolvedValue(undefined);
    mockCollect.mockResolvedValue(undefined);
    mockTranscribe.mockResolvedValue({
      text: 'Complete',
      originalText: 'Raw',
      transcription: { duration: 3, provider: 'cloud' },
    });
    setState({
      transcripts: [],
      currentTranscript: null,
      isLoading: false,
      isLoaded: true,
      error: null,
    });
  });

  it('preserves the initial and current public API', () => {
    const keys = [
      'transcripts',
      'currentTranscript',
      'isLoading',
      'isLoaded',
      'error',
      'loadTranscripts',
      'addTranscript',
      'addFailedTranscript',
      'retryTranscript',
      'updateTranscript',
      'deleteTranscript',
      'setCurrentTranscript',
      'clearTranscripts',
    ];
    if (platform === 'android') keys.push('reset');
    expect(Object.keys(store.getInitialState()).sort()).toEqual(keys.sort());
    expect(Object.keys(store.getState()).sort()).toEqual(keys.sort());
  });

  it('preserves failed-history identity and audio release', async () => {
    const input = {
      id: 'failed-upload',
      audioUrl: 'file://retained.wav',
      provider: 'cloud' as const,
      errorMessage: 'Failed',
      clientTranscriptionId: 'usage-identity',
    };
    await store.getState().addFailedTranscript(input);
    const row = store.getState().transcripts[0];
    if (platform === 'ios') {
      expect(row).not.toHaveProperty('clientTranscriptionId');
      expect(mockRelease).not.toHaveBeenCalled();
    } else {
      expect(row.clientTranscriptionId).toBe('usage-identity');
      expect(mockRelease).toHaveBeenCalledWith('file://retained.wav');
    }
    expect(mockSave.mock.calls[0]).toHaveLength(platform === 'ios' ? 1 : 2);
  });

  it('preserves retry transport options', async () => {
    setState({ transcripts: [failed] });
    await store.getState().retryTranscript('fixture');
    const request = mockTranscribe.mock.calls[0][0];
    if (platform === 'ios') {
      expect(request).not.toHaveProperty('signal');
      expect(request).not.toHaveProperty('clientTranscriptionId');
    } else {
      expect(request.signal.aborted).toBe(false);
      expect(request.clientTranscriptionId).toBe('original-job');
    }
  });

  it('preserves provider AbortError handling', async () => {
    setState({ transcripts: [failed] });
    mockTranscribe.mockRejectedValueOnce(
      Object.assign(new Error('Provider aborted'), { name: 'AbortError' }),
    );
    await expect(store.getState().retryTranscript('fixture')).rejects.toThrow(
      platform === 'ios' ? 'Provider aborted' : 'Transcription cancelled.',
    );
    if (platform === 'ios') {
      expect(store.getState().transcripts[0]).toMatchObject({
        retryCount: 1,
        errorMessage: 'Provider aborted',
      });
      expect(mockSave).toHaveBeenCalledTimes(1);
    } else {
      expect(store.getState().transcripts).toEqual([failed]);
      expect(mockSave).not.toHaveBeenCalled();
    }
  });

  it('preserves private-mode upload routing', async () => {
    mockMode.activeMode = 'private';
    setState({ transcripts: [{ ...failed, provider: 'local', requestContext: 'file' }] });
    const retry = store.getState().retryTranscript('fixture');
    if (platform === 'ios') await expect(retry).resolves.toMatchObject({ status: 'completed' });
    else {
      await expect(retry).rejects.toThrow('Turn off Local Mode');
      expect(mockTranscribe).not.toHaveBeenCalled();
    }
  });

  it('coalesces loads and uses the platform storage contract', async () => {
    setState({ isLoaded: false });
    const first = store.getState().loadTranscripts(),
      second = store.getState().loadTranscripts();
    expect(first).toBe(second);
    await first;
    expect(mockRead.mock.calls).toEqual(platform === 'ios' ? [[]] : [[null]]);
    expect(mockCollect).toHaveBeenCalledWith([]);
  });
});
