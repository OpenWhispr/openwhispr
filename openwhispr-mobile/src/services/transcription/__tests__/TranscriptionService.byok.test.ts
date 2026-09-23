import * as FileSystem from 'expo-file-system/legacy';
import { BackgroundUploader } from '../../../../modules/background-uploader/src';
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
const mockHints = jest.fn((): string[] => []);
jest.mock('@/lib/dictationHints', () => ({
  buildDictationHints: () => mockHints(),
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

const mockClearRecovery = jest.fn();
jest.mock('@/lib/keyboardInferenceRoute', () => ({
  clearKeyboardProviderRecovery: (jobId: string) => mockClearRecovery(jobId),
}));

const mockTranscribeWithProvider = transcribeWithProvider as jest.MockedFunction<
  typeof transcribeWithProvider
>;

beforeEach(() => {
  jest.clearAllMocks();
  mockHints.mockReturnValue([]);
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

test('BYOK sends the custom dictionary as the transcription prompt', async (): Promise<void> => {
  mockHints.mockReturnValue(['OpenWhispr', 'Gizmo']);
  await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'recording',
    inferenceRoute: mockProviderRoute,
  });
  expect(mockTranscribeWithProvider).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: 'OpenWhispr, Gizmo' }),
  );
});

test('BYOK omits the prompt when the dictionary is empty', async (): Promise<void> => {
  await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'recording',
    inferenceRoute: mockProviderRoute,
  });
  expect(mockTranscribeWithProvider.mock.calls[0]?.[0]?.prompt).toBeUndefined();
});

test('BYOK trims an oversized dictionary to the Groq prompt budget at an entry boundary', async (): Promise<void> => {
  const entries = Array.from({ length: 120 }, (_, index) => `Vocabulary${index}`);
  mockHints.mockReturnValue(entries);
  expect(entries.join(', ').length).toBeGreaterThan(890);

  await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'recording',
    inferenceRoute: mockProviderRoute,
  });

  const prompt = mockTranscribeWithProvider.mock.calls[0]?.[0]?.prompt ?? '';
  expect(prompt.length).toBeGreaterThan(0);
  expect(prompt.length).toBeLessThanOrEqual(890);
  const sent = prompt.split(', ');
  expect(sent).toEqual(entries.slice(0, sent.length));
});

test('BYOK keeps a 2000-char dictionary intact for gpt-4o-transcribe', async (): Promise<void> => {
  mockResolvedProviderRoute = {
    mode: 'providers',
    scope: 'dictation',
    providerId: 'openai',
    modelId: 'gpt-4o-transcribe',
    endpoint: 'https://api.openai.com/v1',
    credentialRef: 'provider.openai',
  };
  const entries = Array.from(
    { length: 200 },
    (_, index) => `Term${String(index).padStart(4, '0')}`,
  );
  const full = entries.join(', ');
  const padded = `${full}, ${'x'.repeat(2000 - full.length - 2)}`;
  expect(padded.length).toBe(2000);
  mockHints.mockReturnValue(padded.split(', '));

  await TranscriptionService.transcribe({
    audioUri: 'file:///recording.wav',
    provider: 'byok',
    requestContext: 'recording',
    inferenceRoute: mockResolvedProviderRoute,
  });

  expect(mockTranscribeWithProvider.mock.calls[0]?.[0]?.prompt).toBe(padded);
});

test('BYOK silence clears the recovery entry, since callers discard the audio', async (): Promise<void> => {
  mockTranscribeWithProvider.mockRejectedValueOnce(
    Object.assign(new Error('No speech detected'), { code: 'NO_SPEECH' }),
  );
  await expect(
    TranscriptionService.transcribe({
      audioUri: 'file:///recording.wav',
      provider: 'byok',
      requestContext: 'recording',
      jobId: 'recording-7',
      inferenceRoute: mockProviderRoute,
    }),
  ).rejects.toThrow('No speech detected');
  expect(mockClearRecovery).toHaveBeenCalledWith('recording-7');
});
