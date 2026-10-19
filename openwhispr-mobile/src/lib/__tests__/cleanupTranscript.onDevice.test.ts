/**
 * On-Device cleanup runs through the real retry policy, reasoning routing and
 * Apple Intelligence wrapper; only the native module is faked. A slow or failed
 * run must hand back the raw transcript after one attempt, since a retry would
 * meet the same refusal or time out again.
 */
import { CLEANUP_TIMEOUT_MS, cleanupTranscript } from '@/lib/cleanupTranscript';

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
// The Cloud client imports expo/fetch, which needs the real expo package; an
// On-Device cleanup never reaches it.
jest.mock('@/lib/apiClient', () => ({ api: { post: jest.fn() } }));
// accountAccess pulls in the router for its sign-in alert; stub it here.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: [] }) },
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

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockNative.getAvailability.mockResolvedValue({
    status: 'available',
    contextSize: 4096,
    tokenCounting: true,
  });
  mockNative.countTokens.mockResolvedValue(10);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('pastes the raw transcript at the timeout and stops the model run', async () => {
  mockNative.generateText.mockReturnValue(new Promise(() => undefined));
  const onSkipped = jest.fn();
  const result = cleanupTranscript('um hello there', { inferenceRoute: onDeviceRoute, onSkipped });

  await jest.advanceTimersByTimeAsync(CLEANUP_TIMEOUT_MS);
  // A retry would start a second run before the next timeout; checked before awaiting the
  // result, which a retry would hold back until the timers move again.
  await jest.advanceTimersByTimeAsync(CLEANUP_TIMEOUT_MS);
  expect(mockNative.generateText).toHaveBeenCalledTimes(1);

  await expect(result).resolves.toBe('um hello there');
  expect(onSkipped).toHaveBeenCalledWith(
    'Apple Intelligence took too long. Your raw transcript is saved.',
  );
  const { requestId } = mockNative.generateText.mock.calls[0][0] as { requestId: string };
  expect(mockNative.cancelGeneration).toHaveBeenCalledWith(requestId);
});

// Apple Intelligence writes about as many tokens as the transcript has, so a long one gets
// longer than Cloud's 12 s.
describe('a long transcript', () => {
  beforeEach(() => {
    mockNative.countTokens.mockResolvedValue(600);
  });

  it('is cleaned when the model needs longer than 12 s', async () => {
    mockNative.generateText.mockReturnValue(
      new Promise((resolve) =>
        setTimeout(() => resolve({ text: 'Long text.', model: 'apple-foundation-models' }), 20_000),
      ),
    );
    const result = cleanupTranscript('um long text', { inferenceRoute: onDeviceRoute });

    await jest.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toBe('Long text.');
    expect(mockNative.cancelGeneration).not.toHaveBeenCalled();
  });

  it('still stops a run that never finishes', async () => {
    mockNative.generateText.mockReturnValue(new Promise(() => undefined));
    const onSkipped = jest.fn();
    const result = cleanupTranscript('um long text', { inferenceRoute: onDeviceRoute, onSkipped });

    // 5 s to start, plus 600 tokens at 25 a second.
    await jest.advanceTimersByTimeAsync(28_999);
    expect(mockNative.cancelGeneration).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('um long text');
    expect(mockNative.cancelGeneration).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledWith(
      'Apple Intelligence took too long. Your raw transcript is saved.',
    );
  });
});

it.each([
  ['APPLE_LLM_RATE_LIMITED', 'Apple Intelligence was busy.'],
  ['APPLE_LLM_CONTEXT_LIMIT', 'This transcript is too long for On-Device cleanup.'],
  ['APPLE_LLM_GUARDRAIL', 'Cleanup failed.'],
  ['APPLE_LLM_FAILED', 'Cleanup failed.'],
])('pastes the raw transcript after one %s attempt', async (code, reason) => {
  mockNative.generateText.mockRejectedValue(Object.assign(new Error('refused'), { code }));
  const onSkipped = jest.fn();
  const result = cleanupTranscript('um hello there', { inferenceRoute: onDeviceRoute, onSkipped });

  await jest.advanceTimersByTimeAsync(CLEANUP_TIMEOUT_MS);
  expect(mockNative.generateText).toHaveBeenCalledTimes(1);

  await expect(result).resolves.toBe('um hello there');
  expect(onSkipped).toHaveBeenCalledWith(`${reason} Your raw transcript is saved.`);
});

// The skip before the run counts once; ReasoningService counts again for the context and the
// output cap, and a higher second count refuses the run as too long.
it('names a too-long transcript when ReasoningService refuses it', async () => {
  mockNative.countTokens
    .mockResolvedValueOnce(600)
    .mockResolvedValueOnce(800)
    .mockResolvedValueOnce(2_000);
  const onSkipped = jest.fn();

  await expect(
    cleanupTranscript('um hello there', { inferenceRoute: onDeviceRoute, onSkipped }),
  ).resolves.toBe('um hello there');
  expect(mockNative.generateText).not.toHaveBeenCalled();
  expect(onSkipped).toHaveBeenCalledWith(
    'This transcript is too long for On-Device cleanup. Your raw transcript is saved.',
  );
});

it('returns the cleaned text when the model answers in time', async () => {
  mockNative.generateText.mockResolvedValue({
    text: 'Hello there.',
    model: 'apple-foundation-models',
  });
  await expect(
    cleanupTranscript('um hello there', { inferenceRoute: onDeviceRoute }),
  ).resolves.toBe('Hello there.');
});
