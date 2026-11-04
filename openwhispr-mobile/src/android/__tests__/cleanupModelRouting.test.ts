import { Platform } from 'react-native';
import { initLlama } from 'llama.rn';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { cleanupTranscript } from '@/lib/cleanupTranscript';
import {
  clearLocalReasoningReadinessCache,
  getLocalReasoningReadiness,
} from '@/lib/localReasoning';
import { AppleLLM } from '@/lib/appleLLM';
import { LocalTextModel } from '../LocalTextModel';
import type { ReasoningRequest } from '@/types';

let mockInstalled = new Set(['qwen-cleanup']);
let mockSelected = 'qwen-balanced';
jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));
jest.mock('../models', () => ({
  ANDROID_MODELS: {
    'qwen-cleanup': { title: 'Qwen3 4B' },
    'qwen-balanced': { title: 'Qwen3 1.7B' },
    'qwen-small': { title: 'Qwen 0.5B' },
  },
  modelReady: async (id: string) => mockInstalled.has(id),
  modelPath: (id: string) => `/models/${id}.gguf`,
}));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    releaseParakeet: jest.fn(async () => undefined),
    releaseMoonshine: jest.fn(async () => undefined),
  },
}));
jest.mock('@/services/reasoning/LocalReasoningService', () =>
  jest.requireActual('@/services/reasoning/LocalReasoningService.android'),
);
jest.mock('@/lib/appleLLM', () => ({ AppleLLM: { getAvailability: jest.fn() } }));
jest.mock('@/lib/apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('@/lib/inferenceRouting', () => ({ getInferenceSelection: () => undefined }));
jest.mock('@/lib/accountAccess', () => ({ requiresRealAccount: () => false }));
jest.mock('@/lib/dictationHints', () => ({
  buildDictationHintTiers: () => [['Piha'], ['Acme'], []],
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => undefined,
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u' } }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'private' }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ config: { cleanupEnabled: true, androidTextModel: mockSelected } }),
  },
}));

const originalPlatform = Platform.OS;
const completion = jest.fn();
const release = jest.fn(async () => undefined);
beforeEach(() => {
  jest.clearAllMocks();
  clearLocalReasoningReadinessCache();
  Platform.OS = 'android';
  mockInstalled = new Set(['qwen-cleanup']);
  mockSelected = 'qwen-balanced';
  completion.mockResolvedValue({ text: 'Raw native wrapper.', content: 'Clean transcript.' });
  jest
    .mocked(initLlama)
    .mockReset()
    .mockResolvedValue({ completion, release } as never);
});
afterEach(async () => {
  await LocalTextModel.release();
  Platform.OS = originalPlatform;
});

const cleanupRequest: ReasoningRequest = {
  text: 'uh a message',
  inferenceScope: 'cleanup',
  inferenceRoute: { mode: 'local', scope: 'cleanup' },
  localModelPurpose: 'cleanup',
};

it('runs cleanup when only its artifact is installed, returning parsed answer content', async () => {
  await expect(ReasoningService.processText(cleanupRequest)).resolves.toEqual({
    text: 'Clean transcript.',
    model: 'qwen-cleanup',
  });
  expect(initLlama).toHaveBeenCalledWith(
    expect.objectContaining({
      model: '/models/qwen-cleanup.gguf',
      n_threads: 4,
      no_extra_bufts: true,
    }),
  );
  expect(completion).toHaveBeenCalledWith(
    expect.objectContaining({
      jinja: true,
      reasoning_format: 'auto',
      temperature: 0.7,
      top_k: 20,
      top_p: 0.8,
      min_p: 0,
      penalty_present: 0,
      penalty_freq: 0,
      penalty_repeat: 1,
      penalty_last_n: 4096,
      seed: 196,
      n_predict: 900,
    }),
  );
});

it.each([
  [128, 128],
  [384, 384],
  [900, 900],
  [1200, 900],
])(
  'honors an explicit cleanup budget of %s within the existing hard ceiling',
  async (maxTokens, expected) => {
    await ReasoningService.processText({ ...cleanupRequest, maxTokens });
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({ n_predict: expected }));
  },
);

it('does not substitute an installed legacy model when the cleanup artifact is missing', async () => {
  mockInstalled = new Set(['qwen-balanced']);
  await expect(ReasoningService.processText(cleanupRequest)).rejects.toMatchObject({
    code: 'LOCAL_REASONING_UNAVAILABLE',
  });
  expect(initLlama).not.toHaveBeenCalled();
});

it.each(['notes', 'agent', 'noteChat', 'cleanup'] as const)(
  'preserves selected legacy models for unmarked %s requests',
  async (scope) => {
    mockInstalled = new Set(['qwen-small', 'qwen-balanced', 'qwen-cleanup']);
    for (const model of ['qwen-small', 'qwen-balanced']) {
      mockSelected = model;
      await expect(
        ReasoningService.processText({
          text: 'An input.',
          systemPrompt: 'Follow the requested task.',
          inferenceScope: scope,
          inferenceRoute: { mode: 'local', scope },
        }),
      ).resolves.toMatchObject({ model });
      expect(completion).toHaveBeenLastCalledWith(expect.objectContaining({ n_predict: 384 }));
      expect(jest.mocked(initLlama).mock.calls.at(-1)?.[0]).not.toHaveProperty('no_extra_bufts');
    }
  },
);

it('keeps personal and shared dictionary hints when only the cleanup model is ready', async () => {
  await expect(
    cleanupTranscript('a message for piha at acme', {
      inferenceRoute: { mode: 'local', scope: 'cleanup' },
    }),
  ).resolves.toBe('Clean transcript.');
  expect(completion).toHaveBeenCalledWith(expect.objectContaining({ n_predict: 900 }));
  const instructions = completion.mock.calls[0][0].messages[0].content;
  expect(instructions).toContain('Piha');
  expect(instructions).toContain('Acme');
  expect(instructions).toContain('Preserve existing paragraph breaks and topic order.');
  expect(instructions).toContain(
    'Never invent facts, promises, approvals, tasks or completed actions.',
  );
});

it.each(['stopped_limit', 'context_full', 'truncated'])(
  'preserves the raw cleanup transcript when native output reports %s',
  async (flag) => {
    const rawText = 'Rina can investigate if the logs arrive, but she has not committed.';
    const onSkipped = jest.fn();
    completion.mockResolvedValue({
      text: 'Rina will investigate.',
      content: 'Rina will investigate.',
      [flag]: true,
    });
    await expect(
      cleanupTranscript(rawText, {
        inferenceRoute: { mode: 'local', scope: 'cleanup' },
        onSkipped,
      }),
    ).resolves.toBe(rawText);
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({ n_predict: 900 }));
    expect(onSkipped).toHaveBeenCalledWith(
      expect.stringContaining('Your raw transcript is saved.'),
    );
  },
);

it('releases the previous context when moving from cleanup to Notes', async () => {
  mockInstalled.add('qwen-balanced');
  await ReasoningService.processText(cleanupRequest);
  await ReasoningService.processText({
    text: 'Meeting details.',
    systemPrompt: 'Summarize.',
    inferenceScope: 'notes',
    inferenceRoute: { mode: 'local', scope: 'notes' },
  });
  expect(release).toHaveBeenCalledTimes(1);
  expect(jest.mocked(initLlama).mock.calls.map(([params]) => params.model)).toEqual([
    '/models/qwen-cleanup.gguf',
    '/models/qwen-balanced.gguf',
  ]);
});

it('does not start cleanup generation after cancellation during native loading', async () => {
  const controller = new AbortController();
  jest.mocked(initLlama).mockImplementationOnce(async () => {
    controller.abort();
    return { completion, release } as never;
  });
  await expect(
    ReasoningService.processText({ ...cleanupRequest, signal: controller.signal }),
  ).rejects.toMatchObject({ retryable: false });
  expect(completion).not.toHaveBeenCalled();
});

it('ignores the cleanup purpose for iOS availability and keeps the Apple cache', async () => {
  Platform.OS = 'ios';
  jest.mocked(AppleLLM.getAvailability).mockResolvedValue({
    status: 'available',
    contextSize: 4096,
    tokenCounting: true,
  });
  await expect(getLocalReasoningReadiness({ localModelPurpose: 'cleanup' })).resolves.toMatchObject(
    { status: 'ready', tokenCounting: true },
  );
  await getLocalReasoningReadiness();
  expect(AppleLLM.getAvailability).toHaveBeenCalledTimes(1);
  expect(initLlama).not.toHaveBeenCalled();
});

it.each([
  ['cleanup', 'Qwen3 4B'],
  [undefined, 'Qwen3 1.7B'],
] as const)('identifies the download needed for purpose %s', async (localModelPurpose, title) => {
  mockInstalled.clear();
  await expect(
    ReasoningService.processText({ ...cleanupRequest, localModelPurpose }),
  ).rejects.toThrow(title);
});
