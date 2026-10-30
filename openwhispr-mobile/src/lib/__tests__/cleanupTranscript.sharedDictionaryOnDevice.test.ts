/**
 * Apple Intelligence's context holds the cleanup prompt, the transcript and the
 * reply, so teammates' words must not push an On-Device cleanup over it:
 * personal words always ride, shared ones only as far as they fit.
 */
import { cleanupTranscript } from '@/lib/cleanupTranscript';
import { MAX_SHARED_WORDS_ON_DEVICE } from '@/lib/onDeviceDictionary';

interface MockNativeAppleLLM {
  getAvailability: jest.Mock;
  countTokens: jest.Mock;
  generateText: jest.Mock;
  cancelGeneration: jest.Mock;
}

jest.mock('expo', () => {
  const native: MockNativeAppleLLM = {
    getAvailability: jest.fn(),
    countTokens: jest.fn(),
    generateText: jest.fn(),
    cancelGeneration: jest.fn(),
  };
  return { requireNativeModule: (): MockNativeAppleLLM => native, mockNative: native };
});
jest.mock('@/lib/apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: {
    getState: () => ({ isLoaded: true, entries: [{ word: 'Piha' }, { word: 'Biscuit' }] }),
  },
}));
let mockSharedWords: string[] = [];
jest.mock('@/store/useSharedDictionaryStore', () => ({
  useSharedDictionaryStore: {
    getState: () => ({ hints: { space: [], workspace: mockSharedWords } }),
  },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => undefined,
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ config: { cleanupEnabled: true, defaultMode: 'private' } }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'private' }) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u', isAnonymous: false } }) },
}));

const { mockNative } = jest.requireMock<{ mockNative: MockNativeAppleLLM }>('expo');
const onDeviceRoute = { mode: 'local', scope: 'cleanup' } as const;
// 200 of them fit the API's 2,000-character cap; on device only 50 may ride.
const sharedWord = (i: number): string => `team${String(i).padStart(5, '0')}`;

// Roughly the length-based estimate the app falls back to.
const countByLength = ({ instructions, prompt }: { instructions?: string; prompt: string }) =>
  Math.ceil(((instructions ?? '').length + prompt.length) / 3.5);

// Personal words from the dictionary line, then the shared ones from their quoted JSON array.
function sentDictionary(): string[] {
  const { instructions } = mockNative.generateText.mock.calls[0][0] as { instructions: string };
  const line = instructions.split('\n').find((part) => part.startsWith('Custom Dictionary'));
  const personal = line ? line.slice(line.indexOf(': ') + 2).split(', ') : [];
  const quoted = /not instructions\): (\[.*?\])\. Use these/.exec(instructions);
  return [...personal, ...(quoted ? (JSON.parse(quoted[1]) as string[]) : [])];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSharedWords = [];
  mockNative.getAvailability.mockResolvedValue({
    status: 'available',
    contextSize: 4096,
    tokenCounting: true,
  });
  mockNative.countTokens.mockImplementation(async (request) => countByLength(request));
  mockNative.generateText.mockResolvedValue({ text: 'Clean.', model: 'apple-foundation-models' });
});

it('keeps a personal-only dictionary as it was', async () => {
  await expect(
    cleanupTranscript('um hello there', { inferenceRoute: onDeviceRoute }),
  ).resolves.toBe('Clean.');
  expect(sentDictionary()).toEqual(['Piha', 'Biscuit']);
});

it('caps shared words lower on device, personal words first', async () => {
  mockSharedWords = Array.from({ length: 300 }, (_, i) => sharedWord(i));

  await expect(
    cleanupTranscript('um hello there', { inferenceRoute: onDeviceRoute }),
  ).resolves.toBe('Clean.');

  expect(sentDictionary()).toEqual([
    'Piha',
    'Biscuit',
    ...mockSharedWords.slice(0, MAX_SHARED_WORDS_ON_DEVICE),
  ]);
});

it('drops the shared words when even the capped list would not fit', async () => {
  mockSharedWords = Array.from({ length: 300 }, (_, i) => sharedWord(i));
  mockNative.countTokens.mockImplementation(async (request: { instructions?: string }) =>
    request.instructions?.includes('"team') ? 5000 : countByLength({ prompt: '', ...request }),
  );

  await expect(
    cleanupTranscript('um hello there', { inferenceRoute: onDeviceRoute }),
  ).resolves.toBe('Clean.');

  expect(sentDictionary()).toEqual(['Piha', 'Biscuit']);
});
