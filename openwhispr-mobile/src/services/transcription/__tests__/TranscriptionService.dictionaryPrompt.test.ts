/**
 * The dictionary prompt each transcription path actually sends: a long shared
 * list fills the Whisper decoder's window, and the user's own words always
 * survive, last.
 */
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
const mockLocalTranscribe = jest.fn(async () => ({ text: 'local text', duration: 1 }));
jest.mock('../LocalTranscriptionService', () => ({
  LocalTranscriptionService: {
    isAvailable: () => true,
    transcribe: (...args: unknown[]) => mockLocalTranscribe(...(args as [])),
  },
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

const PERSONAL = ['Piha', 'Biscuit'];
const WORKSPACE = Array.from({ length: 300 }, (_, i) => `ws${String(i).padStart(8, '0')}`);

jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: {
    getState: () => ({ isLoaded: true, entries: [{ word: 'Piha' }, { word: 'Biscuit' }] }),
  },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
let mockSharedWorkspace: string[] = [];
jest.mock('@/store/useSharedDictionaryStore', () => ({
  useSharedDictionaryStore: {
    getState: () => ({ hints: { space: [], workspace: mockSharedWorkspace } }),
  },
}));

const mockProviderRoute = {
  mode: 'providers',
  scope: 'dictation',
  providerId: 'groq',
  modelId: 'whisper-large-v3-turbo',
  endpoint: 'https://api.groq.com/openai/v1',
  credentialRef: 'provider.groq',
} as const;

jest.mock('@/lib/inferenceRouting', () => ({
  resolveMobileProviderRoute: jest.fn(async () => mockProviderRoute),
  getInferenceSelection: () => undefined,
  getPickedLocalModel: () => 'whisper-base',
}));
jest.mock(
  '@/services/providers/ProviderExecution',
  () => ({
    transcribeWithProvider: jest.fn(async () => ({ text: 'Direct provider transcript' })),
  }),
  { virtual: true },
);
jest.mock('@/lib/keyboardInferenceRoute', () => ({
  clearKeyboardProviderRecovery: jest.fn(),
}));

let logSpy: jest.SpyInstance;

beforeEach((): void => {
  jest.clearAllMocks();
  mockSharedWorkspace = WORKSPACE;
  // The service logs each upload; keep the test output quiet.
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
    exists: true,
    isDirectory: false,
    uri: 'file:///recording.wav',
    size: 1024,
    modificationTime: 0,
  });
  jest.mocked(BackgroundUploader.upload).mockResolvedValue({
    status: 200,
    body: JSON.stringify({ text: 'Hello world.' }),
  });
});

afterEach((): void => {
  logSpy.mockRestore();
});

const recording = (provider: TranscriptionRequest['provider']): TranscriptionRequest => ({
  audioUri: 'file:///recording.wav',
  provider,
  requestContext: 'recording',
  inferenceRoute: provider === 'byok' ? mockProviderRoute : undefined,
});

function uploadedParameters(): Record<string, string> {
  const [call] = jest.mocked(BackgroundUploader.upload).mock.calls;
  return (call[0] as { parameters: Record<string, string> }).parameters;
}

// Shared words past the decoder's ~550-character window are never decoded, so
// every Whisper-style path stops the shared fill there.
const DECODER_WINDOW = 550;

function expectFilledEndingWithPersonal(prompt: string | undefined): void {
  expect(prompt?.endsWith(PERSONAL.join(', '))).toBe(true);
  expect(prompt?.length).toBeLessThanOrEqual(DECODER_WINDOW);
  expect(prompt?.length).toBeGreaterThan(DECODER_WINDOW - 12);
  expect(prompt?.startsWith(WORKSPACE[0])).toBe(true);
}

test('cloud request prompt ends with personal words', async (): Promise<void> => {
  await TranscriptionService.transcribe(recording('cloud'));
  const prompt = uploadedParameters().prompt;
  expectFilledEndingWithPersonal(prompt);
});

test('local transcription prompt ends with personal words', async (): Promise<void> => {
  await TranscriptionService.transcribe(recording('local'));
  const [, options] = mockLocalTranscribe.mock.calls[0] as unknown as [string, { prompt: string }];
  expectFilledEndingWithPersonal(options.prompt);
});

test('BYOK prompt ends with personal words', async (): Promise<void> => {
  await TranscriptionService.transcribe(recording('byok'));
  const [input] = jest.mocked(transcribeWithProvider).mock.calls[0];
  expectFilledEndingWithPersonal(input.prompt);
});

// Three-character words: more than 100 of them fit the decoder window.
const SHORT_WORKSPACE = Array.from(
  { length: 150 },
  (_, i) => `w${i.toString(36).padStart(2, '0')}`,
);

test('cloud and local prompts stop at 100 terms in all, personal words included', async (): Promise<void> => {
  mockSharedWorkspace = SHORT_WORKSPACE;
  const expected = [...SHORT_WORKSPACE.slice(0, 98), ...PERSONAL].join(', ');
  await TranscriptionService.transcribe(recording('cloud'));
  expect(uploadedParameters().prompt).toBe(expected);
  await TranscriptionService.transcribe(recording('local'));
  const [, options] = mockLocalTranscribe.mock.calls[0] as unknown as [string, { prompt: string }];
  expect(options.prompt).toBe(expected);
});

test('BYOK prompt carries at most 100 shared words', async (): Promise<void> => {
  mockSharedWorkspace = SHORT_WORKSPACE;
  await TranscriptionService.transcribe(recording('byok'));
  const [input] = jest.mocked(transcribeWithProvider).mock.calls[0];
  expect(input.prompt).toBe([...SHORT_WORKSPACE.slice(0, 100), ...PERSONAL].join(', '));
});

test('a personal-only prompt is the plain joined list', async (): Promise<void> => {
  mockSharedWorkspace = [];
  await TranscriptionService.transcribe(recording('cloud'));
  expect(uploadedParameters().prompt).toBe(PERSONAL.join(', '));
});

test('fused cleanup keeps personal words apart from at most 200 shared ones', async (): Promise<void> => {
  await TranscriptionService.transcribeWithCloudCleanup(recording('cloud'));
  const parameters = uploadedParameters();
  expect(JSON.parse(parameters.customDictionary)).toEqual(PERSONAL);
  // WORKSPACE words are 10 characters, so 200 of them land exactly on the 2,000-character cap.
  expect(JSON.parse(parameters.sharedDictionary)).toEqual(WORKSPACE.slice(0, 200));
  expectFilledEndingWithPersonal(parameters.prompt);
});

test('a personal-only fused request is what it always was', async (): Promise<void> => {
  mockSharedWorkspace = [];
  await TranscriptionService.transcribeWithCloudCleanup(recording('cloud'));
  const parameters = uploadedParameters();
  expect(parameters.customDictionary).toBe(JSON.stringify(PERSONAL));
  expect(parameters).not.toHaveProperty('sharedDictionary');
});
