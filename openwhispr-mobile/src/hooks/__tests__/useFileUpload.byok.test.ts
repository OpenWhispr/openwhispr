import { act, renderHook } from '@testing-library/react-native';

const mockGetDocumentAsync = jest.fn();
const mockGetInfoAsync = jest.fn();
const mockSnapshotTranscriptionJob = jest.fn();
const mockTranscribeAndCleanup = jest.fn();
const mockRetainTranscriptAudio = jest.fn();
const mockAddTranscript = jest.fn();
const mockAddFailedTranscript = jest.fn();
const mockIsLocalModelMissingError = jest.fn();

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]): unknown => mockGetDocumentAsync(...args),
}));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: (...args: unknown[]): unknown => mockGetInfoAsync(...args),
}));
jest.mock('../../../modules/audio-tools/src', () => ({
  AudioTools: { isAvailable: () => false, cleanup: jest.fn(async () => undefined) },
}));
jest.mock('../../services/transcription/TranscriptionService', () => ({
  isOggOpus: () => false,
  isLocalModelMissingError: (error: unknown): unknown => mockIsLocalModelMissingError(error),
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
  deleteManagedTranscriptAudio: jest.fn(async () => undefined),
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
  mockAddTranscript.mockResolvedValue(undefined);
  mockAddFailedTranscript.mockResolvedValue(undefined);
  mockIsLocalModelMissingError.mockReturnValue(false);
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

describe('delivering a completed upload when history is unavailable', () => {
  it('delivers the cleaned result exactly once and reports history failure separately', async () => {
    mockSnapshotTranscriptionJob.mockReturnValue({ provider: 'cloud' });
    pick({ name: 'voice.m4a', size: 1 * MB });
    mockTranscribeAndCleanup.mockResolvedValue({
      text: 'Final cleaned upload.',
      originalText: 'raw upload',
      transcription: { text: 'Final cleaned upload.', provider: 'cloud' },
    });
    mockAddTranscript.mockRejectedValueOnce(new Error('disk full'));
    const onComplete = jest.fn();
    const onError = jest.fn();
    const { result } = renderHook(() => useFileUpload({ onComplete, onError }));
    await act(async () => {
      await result.current.pickAndTranscribeFile().catch(() => undefined);
    });
    expect(mockTranscribeAndCleanup).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('Final cleaned upload.');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('could not be saved') }),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.invocationCallOrder[0]).toBeLessThan(
      onError.mock.invocationCallOrder[0],
    );
    expect(result.current.currentText).toBe('Final cleaned upload.');
    expect(result.current.isProcessing).toBe(false);
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
  });
});

it('delivers a successfully saved upload once', async () => {
  pick({ name: 'voice.m4a', size: 1 * MB });
  mockAddTranscript.mockResolvedValueOnce(undefined);
  const onComplete = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() => useFileUpload({ onComplete, onError }));
  await act(async () => {
    await result.current.pickAndTranscribeFile();
  });
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith('hello');
  expect(onError).not.toHaveBeenCalled();
  expect(mockAddFailedTranscript).not.toHaveBeenCalled();
});

it('still reports a genuine provider failure without delivering a result', async () => {
  pick({ name: 'voice.m4a', size: 1 * MB });
  const providerError = new Error('Provider unavailable');
  mockTranscribeAndCleanup.mockRejectedValueOnce(providerError);
  const onComplete = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() => useFileUpload({ onComplete, onError }));
  await act(async () => {
    await expect(result.current.pickAndTranscribeFile()).rejects.toThrow('Provider unavailable');
  });
  expect(onComplete).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(providerError);
  expect(mockAddTranscript).not.toHaveBeenCalled();
  expect(mockAddFailedTranscript).toHaveBeenCalledWith(
    expect.objectContaining({ errorMessage: 'Provider unavailable' }),
  );
});

it('delivers a consented cloud retry even when its history write fails', async () => {
  mockSnapshotTranscriptionJob.mockReturnValue({ provider: 'local' });
  pick({ name: 'voice.m4a', size: 1 * MB });
  const modelError = new Error('Local model missing');
  mockIsLocalModelMissingError.mockImplementation((error) => error === modelError);
  mockTranscribeAndCleanup.mockRejectedValueOnce(modelError);
  const onLocalModelMissing = jest.fn();
  const onComplete = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() => useFileUpload({ onLocalModelMissing, onComplete, onError }));
  await act(async () => {
    await result.current.pickAndTranscribeFile();
  });
  expect(onLocalModelMissing).toHaveBeenCalledTimes(1);
  expect(mockAddFailedTranscript).toHaveBeenCalledTimes(1);
  expect(onComplete).not.toHaveBeenCalled();
  mockAddTranscript.mockRejectedValueOnce(new Error('disk full'));
  await act(async () => {
    await onLocalModelMissing.mock.calls[0][0]();
  });
  expect(mockTranscribeAndCleanup).toHaveBeenCalledTimes(2);
  expect(mockTranscribeAndCleanup).toHaveBeenLastCalledWith(
    expect.objectContaining({ provider: 'cloud' }),
    expect.anything(),
  );
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith('hello');
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'Your transcript could not be saved to history.' }),
  );
  expect(mockAddFailedTranscript).toHaveBeenCalledTimes(1);
  expect(result.current.isProcessing).toBe(false);
});
