import { act, renderHook } from '@testing-library/react-native';

const mockGetDocumentAsync = jest.fn();
const mockGetInfoAsync = jest.fn();
const mockDeleteAsync = jest.fn(async (..._args: unknown[]) => undefined);
const mockSnapshotTranscriptionJob = jest.fn();
const mockTranscribeAndCleanup = jest.fn();
const mockRetainTranscriptAudio = jest.fn();
const mockAddTranscript = jest.fn();
const mockAddFailedTranscript = jest.fn();
const mockDeleteManagedTranscriptAudio = jest.fn();

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]): unknown => mockGetDocumentAsync(...args),
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file://app-cache/',
  deleteAsync: (...args: unknown[]) => mockDeleteAsync(...args),
  getInfoAsync: (...args: unknown[]): unknown => mockGetInfoAsync(...args),
}));
jest.mock('../../../modules/audio-tools/src', () => ({
  AudioTools: { isAvailable: () => false, cleanup: jest.fn(async () => undefined) },
}));
jest.mock('../../services/transcription/TranscriptionService', () => ({
  isOggOpus: () => false,
  isLocalModelMissingError: () => false,
}));
jest.mock('../../store/useTranscriptStore', () => ({
  createTranscriptId: () => 'upload-1',
  useTranscriptStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ addTranscript: mockAddTranscript, addFailedTranscript: mockAddFailedTranscript }),
}));
jest.mock('../../lib/inferenceRouting', () => ({
  snapshotTranscriptionJob: (scope: string): unknown => mockSnapshotTranscriptionJob(scope),
  snapshotTextInference: () => ({}),
}));
jest.mock('../../lib/transcribeAndCleanup', () => ({
  transcribeAndCleanup: (...args: unknown[]): unknown => mockTranscribeAndCleanup(...args),
}));
jest.mock('../../lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: () => 'en',
}));
jest.mock('../../lib/permissions', () => ({ isNoSpeechError: () => false }));
jest.mock('../../lib/transcriptAudio', () => ({
  retainTranscriptAudio: (...args: unknown[]): unknown => mockRetainTranscriptAudio(...args),
  deleteManagedTranscriptAudio: (...args: unknown[]): unknown =>
    mockDeleteManagedTranscriptAudio(...args),
}));

import { useFileUpload } from '../useFileUpload';

const byokRoute = {
  provider: 'byok',
  inferenceRoute: {
    mode: 'providers',
    scope: 'upload',
    providerId: 'openai',
    modelId: 'whisper-1',
    endpoint: 'https://api.openai.com/v1',
    credentialRef: 'provider.openai',
  },
};
const MB = 1024 * 1024;

function pick(asset: { name: string; mimeType?: string; size?: number }): void {
  mockGetDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: `file://picked/${asset.name}`, ...asset }],
  });
}

async function upload(): Promise<{ error?: Error; onError: jest.Mock }> {
  const onError = jest.fn();
  const { result } = renderHook(() => useFileUpload({ onError }));
  let error: Error | undefined;
  await act(async () => {
    await result.current.pickAndTranscribeFile().catch((thrown: Error) => {
      error = thrown;
    });
  });
  return { error, onError };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSnapshotTranscriptionJob.mockReturnValue(byokRoute);
  mockGetInfoAsync.mockResolvedValue({ exists: true, size: 1 * MB });
  mockRetainTranscriptAudio.mockResolvedValue('file://docs/transcript-audio/upload-1.m4a');
  mockTranscribeAndCleanup.mockResolvedValue({
    text: 'hello',
    originalText: 'hello',
    transcription: { text: 'hello', provider: 'byok' },
  });
});

describe('provider uploads that the provider would reject', () => {
  it('pins the processing route before the picker opens', async () => {
    mockGetDocumentAsync.mockImplementationOnce(async () => {
      expect(mockSnapshotTranscriptionJob).toHaveBeenCalledTimes(1);
      mockSnapshotTranscriptionJob.mockReturnValue({ provider: 'cloud' });
      return {
        canceled: false,
        assets: [{ uri: 'file://audio.m4a', name: 'audio.m4a', size: MB }],
      };
    });
    await upload();
    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'byok' }),
      expect.anything(),
    );
  });

  it.each(['cancel', 'unmount', 'account-change'])(
    'ignores a picker result after %s',
    async (reason) => {
      let resolvePicker!: (value: unknown) => void;
      mockGetDocumentAsync.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePicker = resolve;
        }),
      );
      let current = true;
      const onComplete = jest.fn();
      const { result, unmount } = renderHook(() =>
        useFileUpload({ isCurrent: () => current, onComplete }),
      );
      let job!: Promise<void>;
      await act(async () => {
        job = result.current.pickAndTranscribeFile();
      });
      if (reason === 'cancel') act(() => result.current.cancel());
      else if (reason === 'unmount') unmount();
      else current = false;
      await act(async () => {
        resolvePicker({
          canceled: false,
          assets: [{ uri: 'file://app-cache/audio.m4a', name: 'audio.m4a', size: MB }],
        });
        await job;
      });
      expect(mockRetainTranscriptAudio).not.toHaveBeenCalled();
      expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
      expect(mockDeleteAsync).toHaveBeenCalledWith('file://app-cache/audio.m4a', {
        idempotent: true,
      });
    },
  );

  it('saves a Notes import only through its destination callback and deletes temporary audio', async () => {
    pick({ name: 'Interview.m4a', size: MB });
    const onComplete = jest.fn();
    const { result } = renderHook(() => useFileUpload({ saveToHistory: false, onComplete }));
    await act(async () => {
      await result.current.pickAndTranscribeFile();
    });
    expect(onComplete).toHaveBeenCalledWith('hello', 'Interview.m4a');
    expect(mockAddTranscript).not.toHaveBeenCalled();
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
    expect(mockDeleteManagedTranscriptAudio).toHaveBeenCalled();
  });

  it('does not save or deliver an import that loses its owner while processing', async () => {
    pick({ name: 'Interview.m4a', size: MB });
    let current = true;
    mockTranscribeAndCleanup.mockImplementationOnce(async () => {
      current = false;
      return { text: 'wrong owner', transcription: { provider: 'byok' } };
    });
    const onComplete = jest.fn();
    const { result } = renderHook(() => useFileUpload({ isCurrent: () => current, onComplete }));
    await act(async () => {
      await result.current.pickAndTranscribeFile();
    });
    expect(mockAddTranscript).not.toHaveBeenCalled();
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(mockDeleteManagedTranscriptAudio).toHaveBeenCalled();
  });
  it('discards a result and its retained audio when the upload is cancelled', async () => {
    pick({ name: 'voice.m4a', size: MB });
    let finish!: () => void;
    const processing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockTranscribeAndCleanup.mockImplementationOnce(async () => {
      await processing;
      return {
        text: 'Discard this',
        originalText: 'Discard this',
        transcription: { provider: 'byok' },
      };
    });
    const onError = jest.fn();
    const { result } = renderHook(() => useFileUpload({ onError }));
    let uploadJob!: Promise<void>;
    await act(async () => {
      uploadJob = result.current.pickAndTranscribeFile();
    });
    expect(mockTranscribeAndCleanup).toHaveBeenCalled();
    await act(async () => {
      result.current.cancel();
      finish();
      await uploadJob;
    });
    expect(mockAddTranscript).not.toHaveBeenCalled();
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
    expect(mockDeleteManagedTranscriptAudio).toHaveBeenCalledWith(
      'file://docs/transcript-audio/upload-1.m4a',
    );
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.isProcessing).toBe(false);
  });
  it.each(['voice.aac', 'voice.opus'])('refuses %s before creating a job', async (name) => {
    pick({ name, size: 1 * MB });
    const { error } = await upload();
    expect(error?.message).toBe(
      'Your provider accepts FLAC, MP3, MP4, M4A, OGG, WAV, or WEBM audio. Choose a file in one of those formats.',
    );
    expect(mockRetainTranscriptAudio).not.toHaveBeenCalled();
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
    expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
  });

  it('refuses a file over 25 MB whose size the picker did not report', async () => {
    pick({ name: 'long.m4a' });
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 26 * MB });
    const { error } = await upload();
    expect(error?.message).toBe(
      'Your provider accepts audio files up to 25 MB. Choose a smaller file.',
    );
    expect(mockRetainTranscriptAudio).not.toHaveBeenCalled();
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
  });

  it('sends a supported file within the limit to the provider', async () => {
    pick({ name: 'voice.m4a' });
    const { error } = await upload();
    expect(error).toBeUndefined();
    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'byok', inferenceRoute: byokRoute.inferenceRoute }),
      expect.anything(),
    );
  });

  it('still lets OpenWhispr Cloud take AAC uploads', async () => {
    mockSnapshotTranscriptionJob.mockReturnValue({ provider: 'cloud' });
    pick({ name: 'voice.aac', size: 1 * MB });
    const { error } = await upload();
    expect(error).toBeUndefined();
    expect(mockTranscribeAndCleanup).toHaveBeenCalled();
  });
});
