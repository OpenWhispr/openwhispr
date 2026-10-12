import * as FileSystem from 'expo-file-system/legacy';
import { BackgroundUploader } from '../../../../modules/background-uploader/src';
import { AudioTools } from '../../../../modules/audio-tools/src';
import { TranscriptionService } from '../TranscriptionService';
import type { TranscriptionRequest } from '../../../types';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.2.1' } },
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ sessionCookie: 'test-session-cookie' }) },
}));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { FOREGROUND: 0 },
}));
jest.mock('../LocalWhisperService', () => ({ LocalWhisperService: {} }));
jest.mock('../LocalTranscriptionService', () => ({ LocalTranscriptionService: {} }));
jest.mock('@/lib/dictationHints', () => ({
  buildDictationHints: () => [],
  isDictationContext: () => true,
}));
jest.mock('@/lib/cleanupTranscript', () => ({ CLEANUP_TIMEOUT_MS: 30000 }));
jest.mock('../../../../modules/background-uploader/src', () => ({
  BackgroundUploader: { isAvailable: () => true, upload: jest.fn() },
}));
jest.mock('../../../../modules/audio-tools/src', () => ({
  AudioTools: { isAvailable: () => true, splitToChunks: jest.fn(), cleanup: jest.fn() },
}));
jest.mock('../../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {},
  APP_GROUP_KEYS: {},
}));

beforeEach((): void => {
  jest.clearAllMocks();
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
    exists: true,
    isDirectory: false,
    uri: 'file:///recording.wav',
    size: 1024,
    modificationTime: 0,
  });
  const response = {
    status: 200,
    body: JSON.stringify({ text: 'Hello world.' }),
    headers: {},
    mimeType: null,
  };
  jest.mocked(FileSystem.uploadAsync).mockResolvedValue(response);
  jest.mocked(BackgroundUploader.upload).mockResolvedValue(response);
  jest.mocked(AudioTools.splitToChunks).mockResolvedValue({
    chunks: ['file:///chunk.wav'],
    durationMs: 1000,
  });
});

describe.each(['keyboard', 'recording'] as const)('%s upload headers', (requestContext): void => {
  it.each([
    { cleanup: false, chunked: false },
    { cleanup: true, chunked: false },
    { cleanup: false, chunked: true },
  ])(
    'identifies mobile with cleanup=$cleanup and chunked=$chunked',
    async ({ cleanup, chunked }): Promise<void> => {
      if (chunked) {
        jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
          exists: true,
          isDirectory: false,
          uri: 'file:///recording.wav',
          size: 8 * 1024 * 1024,
          modificationTime: 0,
        });
      }
      const request: TranscriptionRequest = {
        audioUri: 'file:///recording.wav',
        provider: 'cloud',
        requestContext,
      };
      const result = cleanup
        ? await TranscriptionService.transcribeWithCloudCleanup(request)
        : await TranscriptionService.transcribe(request);

      expect(result.text).toBe('Hello world.');
      const headers = expect.objectContaining({
        Cookie: 'test-session-cookie',
        'x-openwhispr-version': '1.2.1',
        'x-openwhispr-policy-version': '1',
        'x-openwhispr-platform': 'mobile',
      });
      if (requestContext === 'keyboard') {
        expect(FileSystem.uploadAsync).toHaveBeenCalledWith(
          expect.stringContaining('/api/transcribe'),
          chunked ? 'file:///chunk.wav' : request.audioUri,
          expect.objectContaining({ headers }),
        );
        expect(BackgroundUploader.upload).not.toHaveBeenCalled();
      } else {
        expect(BackgroundUploader.upload).toHaveBeenCalledWith(
          expect.objectContaining({ headers }),
        );
        expect(FileSystem.uploadAsync).not.toHaveBeenCalled();
      }
    },
  );
});
