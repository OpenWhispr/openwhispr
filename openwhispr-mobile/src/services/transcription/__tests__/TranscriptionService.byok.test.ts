import * as FileSystem from 'expo-file-system/legacy';
import { BackgroundUploader } from '../../../../modules/background-uploader/src';
import { AppGroupStorage } from '../../../../modules/app-group-storage/src';
import { transcribeWithProvider } from '@/services/providers/ProviderExecution';
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
  AppGroupStorage: { setItem: jest.fn() },
  APP_GROUP_KEYS: {},
}));

const mockProviderRoute = {
  mode: 'providers',
  scope: 'dictation',
  providerId: 'groq',
  modelId: 'whisper-large-v3-turbo',
  endpoint: 'https://api.groq.com/openai/v1',
  credentialRef: 'provider.groq',
} as const;
let mockResolvedProviderRoute: NonNullable<TranscriptionRequest['inferenceRoute']> =
  mockProviderRoute;

const mockCleanupRoute = {
  mode: 'providers',
  scope: 'cleanup',
  providerId: 'openai',
  modelId: 'gpt-4o-mini',
  endpoint: 'https://api.openai.com/v1',
  credentialRef: 'provider.openai',
} as const;

jest.mock('@/lib/inferenceRouting', () => ({
  resolveMobileProviderRoute: jest.fn(async () => mockResolvedProviderRoute),
  getInferenceSelection: () => undefined,
}));
jest.mock('../StreamingFileTranscription', () => ({
  transcribeStreamingFile: jest.fn(),
}));
jest.mock(
  '@/services/providers/ProviderExecution',
  () => ({
    transcribeWithProvider: jest.fn(async () => ({
      text: 'Direct provider transcript',
      duration: 2,
    })),
  }),
  { virtual: true },
);

const mockTranscribeWithProvider = transcribeWithProvider as jest.MockedFunction<
  typeof transcribeWithProvider
>;

beforeEach(() => {
  jest.clearAllMocks();
  mockResolvedProviderRoute = mockProviderRoute;
});

test('BYOK returns provider metadata without an OpenWhispr session or upload', async (): Promise<void> => {
  const response = await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'recording',
    inferenceRoute: mockProviderRoute,
  });

  expect(response).toMatchObject({
    text: 'Direct provider transcript',
    provider: 'byok',
    inferenceRoute: mockProviderRoute,
  });
  expect(BackgroundUploader.upload).not.toHaveBeenCalled();
  expect(FileSystem.uploadAsync).not.toHaveBeenCalled();
});

test('BYOK recovery snapshot preserves the pinned text stages and client job ID', async (): Promise<void> => {
  await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'keyboard',
    clientTranscriptionId: 'client-job-42',
    inferenceRoute: mockProviderRoute,
    cleanupRoute: mockCleanupRoute,
    agentRoute: mockCleanupRoute,
    cleanupUnavailable: 'cleanup unavailable',
    agentUnavailable: 'agent unavailable',
  });

  const providerInput = mockTranscribeWithProvider.mock.calls[0]?.[0];
  expect(providerInput?.jobId).toBe('client-job-42');
  expect(JSON.parse(providerInput?.routeSnapshot ?? '')).toEqual({
    version: 1,
    jobId: 'client-job-42',
    requestContext: 'keyboard',
    route: {
      provider: 'byok',
      inferenceRoute: mockProviderRoute,
      cleanupRoute: mockCleanupRoute,
      agentRoute: mockCleanupRoute,
      cleanupUnavailable: 'cleanup unavailable',
      agentUnavailable: 'agent unavailable',
    },
  });
});

test('streaming BYOK retains the original audio and full route after interruption', async (): Promise<void> => {
  const { transcribeStreamingFile } =
    require('../StreamingFileTranscription') as typeof import('../StreamingFileTranscription');
  const streamingRoute = {
    ...mockProviderRoute,
    providerId: 'assemblyai',
    modelId: 'universal-streaming',
    endpoint: 'https://streaming.assemblyai.com/v3',
    credentialRef: 'provider.assemblyai',
  } as const;
  mockResolvedProviderRoute = streamingRoute;
  jest.mocked(transcribeStreamingFile).mockRejectedValueOnce(new Error('connection interrupted'));

  await expect(
    TranscriptionService.transcribe({
      audioUri: 'file:///retained-original.m4a',
      provider: 'byok',
      requestContext: 'recording',
      jobId: 'stream-job-7',
      inferenceRoute: streamingRoute,
      cleanupRoute: mockCleanupRoute,
      agentUnavailable: 'agent unavailable',
    }),
  ).rejects.toThrow('connection interrupted');

  const setItem = jest.mocked(AppGroupStorage.setItem);
  expect(setItem).toHaveBeenCalledWith(
    'keyboard_upload_audio.stream-job-7',
    'file:///retained-original.m4a',
  );
  const serializedRoute = setItem.mock.calls.find(
    ([key]) => key === 'keyboard_upload_route.stream-job-7',
  )?.[1];
  expect(JSON.parse(serializedRoute ?? '')).toEqual({
    version: 1,
    jobId: 'stream-job-7',
    requestContext: 'recording',
    route: {
      provider: 'byok',
      inferenceRoute: streamingRoute,
      cleanupRoute: mockCleanupRoute,
      agentUnavailable: 'agent unavailable',
    },
  });
  expect(setItem).not.toHaveBeenCalledWith(
    'keyboard_provider_result.stream-job-7',
    expect.any(String),
  );
});

test('Tinfoil upload uses its batch adapter and never the realtime replay protocol', async (): Promise<void> => {
  const { transcribeStreamingFile } = require('../StreamingFileTranscription');
  mockResolvedProviderRoute = {
    ...mockProviderRoute,
    scope: 'upload',
    providerId: 'tinfoil',
    modelId: 'whisper-large-v3-turbo',
    endpoint: 'https://inference.tinfoil.sh/v1',
    credentialRef: 'provider.tinfoil',
  };
  await TranscriptionService.transcribe({
    audioUri: 'file:///upload.wav',
    provider: 'byok',
    requestContext: 'file',
    inferenceRoute: mockResolvedProviderRoute,
  });
  expect(mockTranscribeWithProvider).toHaveBeenCalledWith(
    expect.objectContaining({ route: mockResolvedProviderRoute }),
  );
  expect(transcribeStreamingFile).not.toHaveBeenCalled();
});
