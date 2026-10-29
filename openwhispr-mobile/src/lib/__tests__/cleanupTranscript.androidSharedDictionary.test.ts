import { Platform } from 'react-native';
import { cleanupTranscript } from '../cleanupTranscript';
import { countLocalReasoningTokens, fitsLocalReasoningBudget } from '../localReasoning';
import { ReasoningService } from '@/services/reasoning/ReasoningService';

jest.mock('@/lib/accountAccess', () => ({ requiresRealAccount: () => false }));
jest.mock('@/lib/dictationHints', () => ({
  buildDictationHintTiers: () => [['Piha'], ['Acme'], []],
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u' } }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { cleanupEnabled: true } }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'private' }) },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => 'Keep the entire transcript.',
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/services/reasoning/LocalReasoningService', () => ({
  buildLocalReasoningInstructions: (request: { systemPrompt: string }) => request.systemPrompt,
}));
jest.mock('@/lib/localReasoning', () => ({
  countLocalReasoningTokens: jest.fn(),
  fitsLocalReasoningBudget: jest.fn(async () => true),
  getLocalReasoningReadiness: jest.fn(async () => ({ status: 'ready', contextSize: 4096 })),
  LocalReasoningError: class extends Error {},
}));

const originalPlatform = Platform.OS;
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  jest
    .mocked(ReasoningService.processText)
    .mockResolvedValue({ text: 'Clean transcript.', model: 'm' });
});
afterEach(() => {
  Platform.OS = originalPlatform;
});

it('fits team hints while keeping the Android timeout and bypassing Apple transcript limits', async () => {
  const text = 'A long Android transcript. '.repeat(200);
  await expect(
    cleanupTranscript(text, { inferenceRoute: { mode: 'local', scope: 'cleanup' } }),
  ).resolves.toBe('Clean transcript.');

  expect(countLocalReasoningTokens).not.toHaveBeenCalled();
  expect(fitsLocalReasoningBudget).toHaveBeenCalledWith(
    expect.objectContaining({
      instructions: expect.stringContaining('Keep the entire transcript.'),
      prompt: `<transcript>\n${text}\n</transcript>\n\nOutput only the cleaned transcript.`,
    }),
  );
  expect(ReasoningService.processText).toHaveBeenCalledWith(
    expect.objectContaining({
      text,
      timeoutMs: 120_000,
      customPrompt: 'Keep the entire transcript.',
      customDictionary: ['Piha'],
      sharedDictionary: ['Acme'],
      routing: { isPrivateNote: true },
    }),
  );
});

it('preserves parent cancellation after shared hints have been fitted', async () => {
  const controller = new AbortController();
  controller.abort();
  await cleanupTranscript('Cancelled transcript', {
    inferenceRoute: { mode: 'local', scope: 'cleanup' },
    signal: controller.signal,
  });

  expect(jest.mocked(ReasoningService.processText).mock.calls[0][0].signal?.aborted).toBe(true);
});
