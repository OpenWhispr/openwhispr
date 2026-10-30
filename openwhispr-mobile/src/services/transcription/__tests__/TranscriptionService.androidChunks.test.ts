import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { BackgroundUploader } from '../../../../modules/background-uploader/src';

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
jest.mock('../../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {},
  APP_GROUP_KEYS: {},
}));

jest.mock('../../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    prepareCloudAudio: jest.fn(() => 'cloud-test-job'),
    cancelCloudAudio: jest.fn(),
    splitCloudAudio: jest.fn(),
    cleanupCloudAudio: jest.fn(async () => {}),
  },
}));
const { AndroidDictation: native } =
  require('../../../../modules/android-dictation/src') as typeof import('../../../../modules/android-dictation/src');
const originalPlatform = Platform.OS;
Platform.OS = 'android';
const { TranscriptionService } =
  require('../TranscriptionService') as typeof import('../TranscriptionService');
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  jest.mocked(BackgroundUploader.isAvailable).mockReturnValue(false);
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
    exists: true,
    isDirectory: false,
    uri: 'file:///large.wav',
    size: 8 * 1024 * 1024,
    modificationTime: 0,
  });
});
afterEach(() => {
  Platform.OS = originalPlatform;
});

it('plans splitting for Android Cloud audio above the gateway limit using the real platform adapter', async () => {
  await expect(
    TranscriptionService.requestNeedsChunking({
      audioUri: 'file:///large.wav',
      provider: 'cloud',
      requestContext: 'file',
    }),
  ).resolves.toBe(true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(['wav', 'ogg'])(
  'uploads Android %s chunks in source order and retains the recording duration',
  async (extension) => {
    const chunks = ['file:///chunk-0.wav', 'file:///chunk-1.wav'];
    jest.mocked(native!.splitCloudAudio).mockResolvedValueOnce({ chunks, durationMs: 241000 });
    const first = deferred<FileSystem.FileSystemUploadResult>();
    const arrived: string[] = [];
    jest.mocked(FileSystem.uploadAsync).mockImplementation(async (_url, uri, options) => {
      arrived.push(uri);
      if (!options || !('mimeType' in options)) throw new Error('Expected multipart audio upload');
      expect(options.mimeType).toBe('audio/wav');
      expect(options.parameters?.clientTranscriptionId).toBe(
        `large-upload-chunk${chunks.indexOf(uri)}`,
      );
      if (uri === chunks[0]) return first.promise;
      const result = {
        status: 200,
        headers: {},
        mimeType: null,
        body: JSON.stringify({ text: 'Second sentence.' }),
      };
      first.resolve({ ...result, body: JSON.stringify({ text: 'First sentence.' }) });
      return result;
    });
    const result = await TranscriptionService.transcribe({
      audioUri: `file:///large.${extension}`,
      provider: 'cloud',
      requestContext: 'file',
      clientTranscriptionId: 'large-upload',
    });
    expect(result).toMatchObject({ text: 'First sentence. Second sentence.', duration: 241 });
    expect(arrived).toEqual(chunks);
    expect(native!.splitCloudAudio).toHaveBeenCalledWith(
      `file:///large.${extension}`,
      120,
      'cloud-test-job',
    );
    expect(native!.cleanupCloudAudio).toHaveBeenCalledWith(chunks);
  },
);

it('cancels native splitting and disposes a late result before any upload', async () => {
  const started = deferred<void>();
  const split = deferred<{ chunks: string[]; durationMs: number }>();
  jest.mocked(native!.splitCloudAudio).mockImplementationOnce(async () => {
    started.resolve();
    return split.promise;
  });
  const controller = new AbortController();
  const pending = TranscriptionService.transcribe({
    audioUri: 'file:///large.wav',
    provider: 'cloud',
    requestContext: 'file',
    signal: controller.signal,
  }).catch((error: Error) => error);
  await started.promise;
  controller.abort();
  expect(native!.cancelCloudAudio).toHaveBeenCalledWith('cloud-test-job');
  split.resolve({ chunks: ['file:///late-chunk.wav'], durationMs: 241000 });
  expect(await pending).toMatchObject({ name: 'AbortError' });
  expect(native!.cleanupCloudAudio).toHaveBeenCalledTimes(1);
  expect(native!.cleanupCloudAudio).toHaveBeenCalledWith(['file:///late-chunk.wav']);
  expect(FileSystem.uploadAsync).not.toHaveBeenCalled();
  expect(FileSystem.createUploadTask).not.toHaveBeenCalled();
});

it('keeps small supported Android uploads inline', async () => {
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: true,
    isDirectory: false,
    uri: 'file:///small.wav',
    size: 64044,
    modificationTime: 0,
  });
  await expect(
    TranscriptionService.requestNeedsChunking({
      audioUri: 'file:///small.wav',
      provider: 'cloud',
      requestContext: 'file',
    }),
  ).resolves.toBe(false);
  expect(native!.prepareCloudAudio).not.toHaveBeenCalled();
});
