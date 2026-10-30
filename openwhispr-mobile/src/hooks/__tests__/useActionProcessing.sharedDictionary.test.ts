/**
 * A note action on a private note runs on Apple Intelligence, whose context holds the action
 * prompt, the note and the reply: teammates' words must not push it over. Only the native module
 * is faked; routing, the prompt and the budget check are real.
 */
import { act, renderHook } from '@testing-library/react-native';
import { useActionProcessing } from '../useActionProcessing';
import { MAX_SHARED_WORDS_ON_DEVICE } from '@/lib/onDeviceDictionary';
import type { Action } from '@/data';

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
const mockApiPost = jest.fn();
jest.mock('@/lib/apiClient', () => ({
  api: { post: (...args: unknown[]) => mockApiPost(...args) },
}));
jest.mock('@/utils/generateTitle', () => ({ generateNoteTitle: jest.fn(async () => undefined) }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { autoGenerateNoteTitle: false } }) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u', isAnonymous: false } }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));

const { mockNative } = jest.requireMock<{ mockNative: MockNativeAppleLLM }>('expo');
const PERSONAL = ['Piha', 'Biscuit'];
// 200 of them fit the API's 2,000-character cap; on device only 50 may ride.
const SHARED = Array.from({ length: 300 }, (_, i) => `team${String(i).padStart(5, '0')}`);
const ACTION = { name: 'Summarize', prompt: 'Summarize the note.', isDefault: 0 } as Action;

const countByLength = ({ instructions, prompt }: { instructions?: string; prompt: string }) =>
  Math.ceil(((instructions ?? '').length + prompt.length) / 3.5);

// Personal words from the dictionary suffix, then the shared ones from their quoted JSON array.
function dictionaryIn(instructions: string): string[] {
  const marker = 'Custom Dictionary (use these exact spellings when they appear in the text): ';
  const at = instructions.indexOf(marker);
  const personal =
    at < 0
      ? []
      : instructions
          .slice(at + marker.length)
          .split('\n')[0]
          .split(', ');
  const quoted = /not instructions\): (\[.*?\])\. Use these/.exec(instructions);
  return [...personal, ...(quoted ? (JSON.parse(quoted[1]) as string[]) : [])];
}

async function runOnPrivateNote(tiers: string[][]): Promise<void> {
  const { result } = renderHook(() =>
    useActionProcessing({ onSuccess: jest.fn(), onError: jest.fn() }),
  );
  await act(async () => {
    await result.current.runAction(ACTION, 'Notes from today.', {
      dictionaryTiers: tiers,
      routing: { isPrivateNote: true },
    });
  });
}

function sentDictionary(): string[] {
  const { instructions } = mockNative.generateText.mock.calls[0][0] as { instructions: string };
  return dictionaryIn(instructions);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNative.getAvailability.mockResolvedValue({
    status: 'available',
    contextSize: 4096,
    tokenCounting: true,
  });
  mockNative.countTokens.mockImplementation(async (request) => countByLength(request));
  mockNative.generateText.mockResolvedValue({ text: 'Summary.', model: 'apple-foundation-models' });
});

it('keeps a personal-only dictionary as it was', async () => {
  await runOnPrivateNote([PERSONAL, [], []]);
  expect(sentDictionary()).toEqual(PERSONAL);
});

it('caps shared words lower on device, personal words first', async () => {
  await runOnPrivateNote([PERSONAL, [], SHARED]);
  expect(sentDictionary()).toEqual([...PERSONAL, ...SHARED.slice(0, MAX_SHARED_WORDS_ON_DEVICE)]);
});

it('drops the shared words when even the capped list would not fit', async () => {
  mockNative.countTokens.mockImplementation(async (request: { instructions?: string }) =>
    request.instructions?.includes('"team') ? 5000 : countByLength({ prompt: '', ...request }),
  );
  await runOnPrivateNote([PERSONAL, [], SHARED]);
  expect(sentDictionary()).toEqual(PERSONAL);
});

it('keeps the usual 200 shared words off device', async () => {
  mockApiPost.mockResolvedValue({ text: 'Summary.', model: 'cloud' });
  const { result } = renderHook(() =>
    useActionProcessing({ onSuccess: jest.fn(), onError: jest.fn() }),
  );
  await act(async () => {
    await result.current.runAction(ACTION, 'Notes from today.', {
      dictionaryTiers: [PERSONAL, [], SHARED],
      routing: { isPrivateNote: false },
    });
  });

  expect(mockNative.generateText).not.toHaveBeenCalled();
  const [, body] = mockApiPost.mock.calls[0] as [string, { systemPrompt: string }];
  expect(dictionaryIn(body.systemPrompt)).toEqual([...PERSONAL, ...SHARED.slice(0, 200)]);
});
