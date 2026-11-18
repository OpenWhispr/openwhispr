let mockHistoryScope: { owner: string; key: string; revision: number } | null = null;
jest.mock('@/lib/transcriptScope', () => ({
  captureTranscriptScope: () => mockHistoryScope,
  isTranscriptScopeCurrent: (scope: unknown) => scope === mockHistoryScope,
  observeTranscriptScope: () => () => {},
}));
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

afterEach(() => jest.restoreAllMocks());

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
  mockHistoryScope = null;
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

it('exposes only the upstream default upload API', () => {
  const { result } = renderHook(() => useFileUpload());
  expect(Object.keys(result.current).sort()).toEqual([
    'currentText',
    'isProcessing',
    'pickAndTranscribeFile',
  ]);
});

it('does not mark the default hook busy while the system picker is open', async () => {
  let resolvePicker!: (value: unknown) => void;
  mockGetDocumentAsync.mockReturnValueOnce(
    new Promise((resolve) => {
      resolvePicker = resolve;
    }),
  );
  const { result } = renderHook(() => useFileUpload());
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.pickAndTranscribeFile();
  });
  expect(result.current.isProcessing).toBe(false);
  expect(mockSnapshotTranscriptionJob).not.toHaveBeenCalled();
  await act(async () => {
    resolvePicker({ canceled: true });
    await pending;
  });
  expect(mockSnapshotTranscriptionJob).not.toHaveBeenCalled();
});

it('takes the upstream route snapshot after the picker returns', async () => {
  mockGetDocumentAsync.mockImplementationOnce(async () => {
    mockSnapshotTranscriptionJob.mockReturnValue({ provider: 'cloud' });
    return {
      canceled: false,
      assets: [{ uri: 'file://picked/voice.wav', name: 'voice.wav', size: MB }],
    };
  });
  await upload();
  expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'cloud' }),
    expect.anything(),
  );
});

it('keeps the one-argument completion callback and always saves default history', async () => {
  pick({ name: 'voice.wav', size: MB });
  const onComplete = jest.fn();
  const options = { onComplete, saveToHistory: false };
  const { result } = renderHook(() => useFileUpload(options));
  await act(() => result.current.pickAndTranscribeFile());
  expect(onComplete).toHaveBeenCalledWith('hello');
  expect(mockAddTranscript).toHaveBeenCalledTimes(1);
  expect(mockDeleteManagedTranscriptAudio).not.toHaveBeenCalled();
});

it('ignores the added caller-current option in the default hook', async () => {
  pick({ name: 'voice.wav', size: MB });
  const onComplete = jest.fn();
  const options = { onComplete, isCurrent: () => false };
  const { result } = renderHook(() => useFileUpload(options));
  await act(() => result.current.pickAndTranscribeFile());
  expect(onComplete).toHaveBeenCalledWith('hello');
});

it('keeps the upstream transcription callback argument shape', async () => {
  pick({ name: 'voice.wav', size: MB });
  await upload();
  expect(Object.keys(mockTranscribeAndCleanup.mock.calls[0][1])).toEqual(['onRawTranscript']);
});

it('retains the original callback error and failed-row identity shape', async () => {
  pick({ name: 'voice.wav', size: MB });
  const error = new Error('Network request failed');
  mockTranscribeAndCleanup.mockRejectedValueOnce(error);
  const outcome = await upload();
  expect(outcome.error).toBe(error);
  expect(outcome.onError).toHaveBeenCalledWith(error);
  expect(Object.keys(mockAddFailedTranscript.mock.calls[0][0])).not.toContain(
    'clientTranscriptionId',
  );
});

it('preserves the upstream failed row and rejection for a provider AbortError', async () => {
  pick({ name: 'voice.wav', size: MB });
  const error = Object.assign(new Error('Provider cancelled'), { name: 'AbortError' });
  mockTranscribeAndCleanup.mockRejectedValueOnce(error);
  const outcome = await upload();
  expect(outcome.error).toBe(error);
  expect(outcome.onError).toHaveBeenCalledWith(error);
  expect(mockAddFailedTranscript).toHaveBeenCalledTimes(1);
  expect(mockDeleteManagedTranscriptAudio).not.toHaveBeenCalled();
});

it('does not add Android picker-cache deletion to the default lifecycle', async () => {
  mockGetDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file://app-cache/voice.wav', name: 'voice.wav', size: MB }],
  });
  await upload();
  expect(mockDeleteAsync).not.toHaveBeenCalled();
});

it('ignores a supplied route at the default picker entry', async () => {
  pick({ name: 'voice.wav', size: MB });
  mockSnapshotTranscriptionJob.mockReturnValue({ provider: 'cloud' });
  const { result } = renderHook(() => useFileUpload());
  const pickWithExtraArgument: (route?: typeof byokRoute) => Promise<void> =
    result.current.pickAndTranscribeFile;
  await act(() => pickWithExtraArgument(byokRoute));
  expect(mockSnapshotTranscriptionJob).toHaveBeenCalledWith('upload');
  expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'cloud' }),
    expect.anything(),
  );
});
