jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));
jest.mock('../models', () => ({ modelPath: () => '/model.gguf', modelReady: async () => true }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { androidTextModel: 'qwen-balanced' } }) },
}));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    releaseParakeet: jest.fn(async () => undefined),
    releaseMoonshine: jest.fn(async () => undefined),
  },
}));

import { initLlama } from 'llama.rn';
import { LocalTextModel } from '../LocalTextModel';
import { withRetry, createApiRetryStrategy } from '@/lib/retry';

it('does not repeat failed native model initialization as a network retry', async () => {
  const load = jest
    .mocked(initLlama)
    .mockClear()
    .mockRejectedValue(new Error('Model initialization failed'));
  await expect(
    withRetry(() => LocalTextModel.processText({ text: 'A short message.' }), {
      ...createApiRetryStrategy(),
      maxRetries: 1,
      initialDelay: 0,
    }),
  ).rejects.toThrow('Model initialization failed');
  expect(load).toHaveBeenCalledTimes(1);
});

it('does not run a failed local generation again under the shared network retry policy', async () => {
  const completion = jest.fn(async () => {
    throw new Error('Local generation failed');
  });
  jest.mocked(initLlama).mockResolvedValue({ completion, release: jest.fn() } as never);
  await expect(
    withRetry(() => LocalTextModel.processText({ text: 'A short message.' }), {
      ...createApiRetryStrategy(),
      maxRetries: 1,
      initialDelay: 0,
    }),
  ).rejects.toThrow('Local generation failed');
  expect(completion).toHaveBeenCalledTimes(1);
  await LocalTextModel.release();
});

it('does not begin generation when cancellation happens during model loading', async () => {
  const controller = new AbortController();
  const completion = jest.fn();
  jest.mocked(initLlama).mockImplementationOnce(async () => {
    controller.abort();
    return { completion, release: jest.fn() } as never;
  });
  await expect(
    LocalTextModel.processText({ text: 'A message.', signal: controller.signal }),
  ).rejects.toMatchObject({ retryable: false });
  expect(completion).not.toHaveBeenCalled();
  await LocalTextModel.release();
});

it.each(['native-error', 'context-full', 'truncated'])(
  'reports %s as a recoverable local context limit',
  async (kind) => {
    const completion =
      kind === 'native-error'
        ? jest.fn().mockRejectedValue(new Error('Context is full'))
        : jest.fn().mockResolvedValue({
            text: 'partial output',
            context_full: kind === 'context-full',
            truncated: kind === 'truncated',
          });
    jest.mocked(initLlama).mockResolvedValue({ completion, release: jest.fn() } as never);
    try {
      await expect(LocalTextModel.processText({ text: 'Long meeting' })).rejects.toMatchObject({
        code: 'LOCAL_CONTEXT_LIMIT',
        retryable: false,
      });
    } finally {
      await LocalTextModel.release();
    }
  },
);

it('disables thinking for balanced cleanup and returns only parsed answer content', async () => {
  const completion = jest.fn().mockResolvedValue({
    text: '<think>internal reasoning</think>Edited note.',
    content: 'Edited note.',
    reasoning_content: 'internal reasoning',
  });
  jest.mocked(initLlama).mockResolvedValue({ completion, release: jest.fn() } as never);
  try {
    await expect(
      LocalTextModel.processText({ text: 'uh a note', temperature: 0.3 }, 'qwen-balanced'),
    ).resolves.toEqual({ text: 'Edited note.', model: 'qwen-balanced' });
    expect(completion).toHaveBeenCalledWith(
      expect.objectContaining({
        jinja: true,
        enable_thinking: false,
        reasoning_format: 'auto',
        temperature: 0.3,
        top_k: 20,
        top_p: 0.8,
        min_p: 0,
        penalty_present: 1.5,
      }),
    );
  } finally {
    await LocalTextModel.release();
  }
});

it('does not expose reasoning when a balanced completion has no answer', async () => {
  const completion = jest.fn().mockResolvedValue({
    text: '<think>internal reasoning</think>',
    content: '',
    reasoning_content: 'internal reasoning',
  });
  jest.mocked(initLlama).mockResolvedValue({ completion, release: jest.fn() } as never);
  try {
    await expect(LocalTextModel.processText({ text: 'a note' }, 'qwen-balanced')).rejects.toThrow();
  } finally {
    await LocalTextModel.release();
  }
});

it('preserves the small model completion format and explicit sampling settings', async () => {
  const completion = jest.fn().mockResolvedValue({ text: 'Small model output.', content: '' });
  jest.mocked(initLlama).mockResolvedValue({ completion, release: jest.fn() } as never);
  try {
    await expect(
      LocalTextModel.processText({ text: 'a note', temperature: 0.2 }, 'qwen-small'),
    ).resolves.toEqual({ text: 'Small model output.', model: 'qwen-small' });
    const params = completion.mock.calls[0][0];
    expect(params.temperature).toBe(0.2);
    expect(params.enable_thinking).toBeUndefined();
    expect(params.penalty_present).toBeUndefined();
  } finally {
    await LocalTextModel.release();
  }
});
