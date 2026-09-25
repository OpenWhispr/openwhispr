import { TranscriptionService } from '../TranscriptionService';

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
const mockLocalTranscribe = jest.fn(async () => ({ text: 'local text', duration: 1 }));
const mockPrepare = jest.fn(async () => undefined);
jest.mock('../LocalTranscriptionService', () => ({
  LocalTranscriptionService: {
    isAvailable: () => true,
    transcribe: (...args: unknown[]) => mockLocalTranscribe(...(args as [])),
    prepareForLanguage: (...args: unknown[]) => mockPrepare(...(args as [])),
  },
}));
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
  AppGroupStorage: { setItem: jest.fn() },
  APP_GROUP_KEYS: {},
}));
const mockPicks: Record<string, string | undefined> = {};
jest.mock('@/lib/inferenceRouting', () => ({
  getPickedLocalModel: (scope: string) => mockPicks[scope],
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockPicks.dictation = 'parakeet-v3';
  mockPicks.upload = 'whisper-base';
});

test('on-device files use the Uploads model and recordings use the Dictation model', async () => {
  await TranscriptionService.transcribe({
    audioUri: 'file:///import.m4a',
    provider: 'local',
    requestContext: 'file',
  });
  expect(mockLocalTranscribe).toHaveBeenLastCalledWith(
    'file:///import.m4a',
    expect.objectContaining({ model: 'whisper-base' }),
  );

  await TranscriptionService.transcribe({
    audioUri: 'file:///dictation.wav',
    provider: 'local',
    requestContext: 'keyboard',
  });
  expect(mockLocalTranscribe).toHaveBeenLastCalledWith(
    'file:///dictation.wav',
    expect.objectContaining({ model: 'parakeet-v3' }),
  );
});

test('pre-warming loads the Dictation model', async () => {
  await TranscriptionService.prepareLocal('en');
  expect(mockPrepare).toHaveBeenCalledWith('en', 'parakeet-v3');
});
