// Home's Upload audio card calls cancel() from useFileUpload.android. A cancelled upload must
// never reach History, at whatever stage it was cancelled — even when the request ignores the
// abort and returns its transcript afterwards.
jest.mock('@/lib/transcriptScope', () => ({
  captureTranscriptScope: () => null,
  isTranscriptScopeCurrent: () => true,
  observeTranscriptScope: () => () => {},
}));
import { act, renderHook } from '@testing-library/react-native';

const mockGetDocumentAsync = jest.fn();
const mockTranscribeAndCleanup = jest.fn();
const mockRetainTranscriptAudio = jest.fn();
const mockAddTranscript = jest.fn(async (..._args: unknown[]) => undefined);
const mockAddFailedTranscript = jest.fn(async (..._args: unknown[]) => undefined);
const mockDeleteManagedTranscriptAudio = jest.fn(async (..._args: unknown[]) => undefined);

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]): unknown => mockGetDocumentAsync(...args),
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file://app-cache/',
  deleteAsync: jest.fn(async () => undefined),
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
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
  snapshotTranscriptionJob: () => ({ provider: 'cloud', cleanupRoute: { mode: 'cloud' } }),
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

import { useFileUpload } from '../../hooks/useFileUpload.android';

const RETAINED = 'file://docs/transcript-audio/upload-1.m4a';
const result = {
  text: 'This is a longer recording to test cancelling an upload.',
  originalText: 'This is a longer recording to test cancelling an upload.',
  transcription: { text: 'raw', provider: 'cloud' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function render() {
  const onComplete = jest.fn();
  const onError = jest.fn();
  const hook = renderHook(() => useFileUpload({ onComplete, onError }));
  return { hook, onComplete, onError };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file://app-cache/talk.m4a', name: 'talk.m4a', mimeType: 'audio/mp4' }],
  });
  mockRetainTranscriptAudio.mockResolvedValue(RETAINED);
});

function expectNothingSaved(onComplete: jest.Mock, onError: jest.Mock) {
  expect(mockAddTranscript).not.toHaveBeenCalled();
  expect(mockAddFailedTranscript).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(mockDeleteManagedTranscriptAudio).toHaveBeenCalledWith(RETAINED);
}

it('saves nothing when the request ignores the abort and returns its transcript later', async () => {
  const request = deferred<typeof result>();
  let signal: AbortSignal | undefined;
  let onStage: ((stage: 'cleaning') => void) | undefined;
  mockTranscribeAndCleanup.mockImplementation((_request, options) => {
    signal = options.signal;
    onStage = options.onStage;
    return request.promise;
  });
  const { hook, onComplete, onError } = render();
  let run!: Promise<void>;
  act(() => {
    run = hook.result.current.pickAndTranscribeFile();
  });
  await act(async () => {
    while (!signal) await Promise.resolve();
    onStage?.('cleaning');
  });
  expect(hook.result.current.stage).toBe('cleaning');

  act(() => hook.result.current.cancel());
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    request.resolve(result);
    await run;
  });

  expectNothingSaved(onComplete, onError);
  expect(hook.result.current.isProcessing).toBe(false);
});

it('saves nothing when the request rejects after the cancel', async () => {
  const request = deferred<typeof result>();
  let signal: AbortSignal | undefined;
  mockTranscribeAndCleanup.mockImplementation((_request, options) => {
    signal = options.signal;
    return request.promise;
  });
  const { hook, onComplete, onError } = render();
  let run!: Promise<void>;
  act(() => {
    run = hook.result.current.pickAndTranscribeFile();
  });
  await act(async () => {
    while (!signal) await Promise.resolve();
  });
  act(() => hook.result.current.cancel());
  await act(async () => {
    request.reject(new Error('Network request failed'));
    await run;
  });

  expectNothingSaved(onComplete, onError);
});

it('saves nothing when cancelled while the picked audio is being retained', async () => {
  const retained = deferred<string>();
  mockRetainTranscriptAudio.mockReturnValue(retained.promise);
  const { hook, onComplete, onError } = render();
  let run!: Promise<void>;
  act(() => {
    run = hook.result.current.pickAndTranscribeFile();
  });
  await act(async () => {
    while (!mockRetainTranscriptAudio.mock.calls.length) await Promise.resolve();
  });
  act(() => hook.result.current.cancel());
  await act(async () => {
    retained.resolve(RETAINED);
    await run;
  });

  expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
  expectNothingSaved(onComplete, onError);
});

it('still saves an upload that was not cancelled', async () => {
  mockTranscribeAndCleanup.mockResolvedValue(result);
  const { hook, onComplete } = render();
  await act(async () => {
    await hook.result.current.pickAndTranscribeFile();
  });
  expect(mockAddTranscript).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'upload-1', text: result.text, requestContext: 'file' }),
  );
  expect(onComplete).toHaveBeenCalledWith(result.text, 'talk.m4a');
});
