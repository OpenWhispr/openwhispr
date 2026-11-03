import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { BackgroundUploader } from '../../../../modules/background-uploader/src';
import { CloudAudioTools as AudioTools } from '../cloudAudio';
import { TranscriptionService } from '../TranscriptionService';
import { LocalTranscriptionService } from '../LocalTranscriptionService';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.2.6' } },
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ sessionCookie: 'synthetic-session' }) },
}));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
  uploadAsync: jest.fn(),
  createUploadTask: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { FOREGROUND: 0 },
}));
jest.mock('../LocalWhisperService', () => ({ LocalWhisperService: {} }));
jest.mock('../LocalTranscriptionService', () => ({
  LocalTranscriptionService: { isAvailable: () => true, transcribe: jest.fn() },
}));
jest.mock('@/lib/inferenceRouting', () => ({ getPickedLocalModel: () => 'parakeet-v3' }));
jest.mock('@/lib/dictationHints', () => ({
  buildDictationHintTiers: () => [[], [], []],
  buildLlmDictionary: () => ({ personal: [], shared: [] }),
  isDictationContext: () => true,
}));
jest.mock('@/lib/cleanupTranscript', () => ({ CLEANUP_TIMEOUT_MS: 30000 }));
jest.mock('../../../../modules/background-uploader/src', () => ({
  BackgroundUploader: { isAvailable: jest.fn(), upload: jest.fn() },
}));
jest.mock('../cloudAudio', () => ({
  CloudAudioTools: { isAvailable: () => true, splitToChunks: jest.fn(), cleanup: jest.fn() },
}));
jest.mock('../../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {},
  APP_GROUP_KEYS: {},
}));

const success = {
  status: 200,
  body: JSON.stringify({ text: 'late text' }),
  headers: {},
  mimeType: null,
};
const originalPlatform = Platform.OS;
const tasks: { cancelAsync: jest.Mock }[] = [];
const upload = jest.fn<Promise<typeof success>, []>();
const request = (signal: AbortSignal) => ({
  audioUri: 'file:///recording.wav',
  provider: 'cloud' as const,
  requestContext: 'keyboard' as const,
  signal,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  tasks.length = 0;
  upload.mockReset().mockResolvedValue(success);
  jest.mocked(BackgroundUploader.isAvailable).mockImplementation(() => Platform.OS === 'ios');
  jest.mocked(BackgroundUploader.upload).mockResolvedValue(success);
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
    exists: true,
    isDirectory: false,
    uri: 'file:///recording.wav',
    size: 1024,
    modificationTime: 0,
  });
  jest.mocked(FileSystem.uploadAsync).mockImplementation(() => upload());
  jest.mocked(FileSystem.createUploadTask).mockImplementation(() => {
    const task = { cancelAsync: jest.fn(async () => {}), uploadAsync: () => upload() };
    tasks.push(task);
    return task as unknown as FileSystem.UploadTask;
  });
  jest.mocked(AudioTools.splitToChunks).mockResolvedValue({
    chunks: Array.from({ length: 7 }, (_, i) => `file:///chunk-${i}.wav`),
    durationMs: 1000,
  });
});
afterEach(() => {
  Platform.OS = originalPlatform;
  jest.useRealTimers();
});

it('does not start an already-cancelled cloud upload', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(TranscriptionService.transcribe(request(controller.signal))).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(upload).not.toHaveBeenCalled();
});

it.each(['plain', 'fused', 'chunked'] as const)(
  'cancels each active %s upload and rejects late successful responses',
  async (path) => {
    const controller = new AbortController();
    const started = deferred<void>();
    const held = deferred<typeof success>();
    const expected = path === 'chunked' ? 5 : 1;
    let count = 0;
    upload.mockImplementation(() => {
      if (++count === expected) started.resolve();
      return held.promise;
    });
    if (path === 'chunked')
      jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
        exists: true,
        isDirectory: false,
        uri: 'file:///recording.wav',
        size: 8 * 1024 * 1024,
        modificationTime: 0,
      });
    const input = request(controller.signal);
    const pending = (
      path === 'fused'
        ? TranscriptionService.transcribeWithCloudCleanup(input)
        : TranscriptionService.transcribe(input)
    ).then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    await started.promise;
    controller.abort();
    const cancellations = tasks.map((task) => task.cancelAsync.mock.calls.length);
    expect(AudioTools.cleanup).not.toHaveBeenCalled();
    held.resolve(success);
    expect(await pending).toMatchObject({ error: { name: 'AbortError' } });
    expect(cancellations).toEqual(Array(expected).fill(1));
    expect(upload).toHaveBeenCalledTimes(expected);
    if (path === 'chunked')
      expect(AudioTools.cleanup).toHaveBeenCalledWith(
        Array.from({ length: 7 }, (_, i) => `file:///chunk-${i}.wav`),
      );
  },
);

it('does not start transport when cancellation arrives during file inspection', async () => {
  const controller = new AbortController();
  const inspected = deferred<Awaited<ReturnType<typeof FileSystem.getInfoAsync>>>();
  jest.mocked(FileSystem.getInfoAsync).mockReturnValueOnce(inspected.promise);
  const pending = TranscriptionService.transcribe(request(controller.signal)).then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  controller.abort();
  inspected.resolve({
    exists: true,
    isDirectory: false,
    uri: 'file:///recording.wav',
    size: 1024,
    modificationTime: 0,
  });
  expect(await pending).toMatchObject({ error: { name: 'AbortError' } });
  expect(upload).not.toHaveBeenCalled();
});

it('keeps the existing iOS background upload when a signal is supplied', async () => {
  Platform.OS = 'ios';
  const result = await TranscriptionService.transcribe({
    ...request(new AbortController().signal),
    requestContext: 'recording',
  });
  expect(result.text).toBe('late text');
  expect(BackgroundUploader.upload).toHaveBeenCalledTimes(1);
  expect(FileSystem.createUploadTask).not.toHaveBeenCalled();
});

it('keeps the existing no-signal Android upload path', async () => {
  const { signal: _signal, ...input } = request(new AbortController().signal);
  expect((await TranscriptionService.transcribe(input)).text).toBe('late text');
  expect(FileSystem.uploadAsync).toHaveBeenCalledTimes(1);
  expect(FileSystem.createUploadTask).not.toHaveBeenCalled();
});

it('does not retry after cancellation during upload backoff', async () => {
  jest.useFakeTimers();
  upload.mockResolvedValueOnce({ ...success, status: 503 });
  const controller = new AbortController();
  const pending = TranscriptionService.transcribe(request(controller.signal)).then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  await jest.advanceTimersByTimeAsync(0);
  expect(upload).toHaveBeenCalledTimes(1);
  controller.abort();
  await jest.runAllTimersAsync();
  expect(await pending).toMatchObject({ error: { name: 'AbortError' } });
  expect(upload).toHaveBeenCalledTimes(1);
  // The completed failed attempt has released its abort listener.
  expect(tasks[0].cancelAsync).not.toHaveBeenCalled();
});

it('normalizes a native cancellation rejection without retrying and permits a fresh request', async () => {
  const started = deferred<void>();
  const held = deferred<typeof success>();
  upload.mockImplementationOnce(() => {
    started.resolve();
    return held.promise;
  });
  const controller = new AbortController();
  const pending = TranscriptionService.transcribe(request(controller.signal)).then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  await started.promise;
  controller.abort();
  held.reject(new Error('Native socket cancelled'));
  expect(await pending).toMatchObject({ error: { name: 'AbortError' } });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(tasks[0].cancelAsync).toHaveBeenCalledTimes(1);
  const fresh = new AbortController();
  expect((await TranscriptionService.transcribe(request(fresh.signal))).text).toBe('late text');
  fresh.abort();
  expect(tasks[1].cancelAsync).not.toHaveBeenCalled();
});

it('cleans newly split chunks without uploading if cancellation occurs during splitting', async () => {
  const started = deferred<void>();
  const split = deferred<{ chunks: string[]; durationMs: number }>();
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
    exists: true,
    isDirectory: false,
    uri: 'file:///recording.wav',
    size: 8 * 1024 * 1024,
    modificationTime: 0,
  });
  jest.mocked(AudioTools.splitToChunks).mockImplementationOnce(() => {
    started.resolve();
    return split.promise;
  });
  const controller = new AbortController();
  const pending = TranscriptionService.transcribe(request(controller.signal)).then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  await started.promise;
  controller.abort();
  split.resolve({ chunks: ['file:///newly-split.wav'], durationMs: 1000 });
  expect(await pending).toMatchObject({ error: { name: 'AbortError' } });
  expect(upload).not.toHaveBeenCalled();
  expect(AudioTools.cleanup).toHaveBeenCalledWith(['file:///newly-split.wav']);
});

it('cancels local speech through the service boundary without waiting for a transcript', async () => {
  const started = deferred<void>();
  const controller = new AbortController();
  jest.mocked(LocalTranscriptionService.transcribe).mockImplementationOnce((_uri, options) => {
    started.resolve();
    return new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('stopped'), { name: 'AbortError' })),
      );
    });
  });
  const pending = TranscriptionService.transcribe({
    ...request(controller.signal),
    provider: 'local',
  }).then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  await started.promise;
  expect(jest.mocked(LocalTranscriptionService.transcribe).mock.calls[0][1]?.signal).toBe(
    controller.signal,
  );
  controller.abort();
  expect(await pending).toMatchObject({ error: { name: 'AbortError' } });
  expect(upload).not.toHaveBeenCalled();
});
