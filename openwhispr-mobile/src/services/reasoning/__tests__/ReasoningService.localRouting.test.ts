jest.mock('@/lib/inferenceRouting', () => ({ getInferenceSelection: jest.fn(() => undefined) }));

jest.mock('@/lib/apiClient', () => ({
  api: {
    post: jest.fn(async () => ({
      text: 'cloud result',
      model: 'cloud-model',
      provider: 'cloud',
      processingMs: 1,
    })),
  },
}));

jest.mock('@/lib/localReasoning', () => ({
  fitsLocalCleanupOutput: jest.fn(),
  fitsLocalReasoningBudget: jest.fn(),
  getLocalReasoningReadiness: jest.fn(),
  getLocalReasoningUnavailableMessage: () => 'Local unavailable',
  isLocalReasoningRequired: jest.fn(),
  LocalReasoningError: class MockLocalReasoningError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

jest.mock('@/services/reasoning/LocalReasoningService', () => ({
  buildLocalReasoningInstructions: jest.fn(() => 'local instructions'),
  LocalReasoningService: {
    processText: jest.fn(),
  },
}));

import { ReasoningService } from '../ReasoningService';
import { api } from '@/lib/apiClient';
import {
  fitsLocalCleanupOutput,
  fitsLocalReasoningBudget,
  getLocalReasoningReadiness,
  isLocalReasoningRequired,
} from '@/lib/localReasoning';
import { LocalReasoningService } from '@/services/reasoning/LocalReasoningService';

const mockPost = api.post as jest.Mock;
const mockIsLocalRequired = isLocalReasoningRequired as jest.Mock;
const mockGetReadiness = getLocalReasoningReadiness as jest.Mock;
const mockFitsBudget = fitsLocalReasoningBudget as jest.Mock;
const mockFitsCleanupOutput = fitsLocalCleanupOutput as jest.Mock;
const mockLocalProcessText = LocalReasoningService.processText as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsLocalRequired.mockReturnValue(true);
  mockGetReadiness.mockResolvedValue({
    status: 'ready',
    contextSize: 4096,
    tokenCounting: true,
  });
  mockFitsBudget.mockResolvedValue(true);
  mockFitsCleanupOutput.mockResolvedValue(true);
  mockLocalProcessText.mockResolvedValue({ text: 'local result', model: 'apple-fm' });
});

describe('ReasoningService local routing', () => {
  it('returns local output without calling cloud for privacy-constrained content', async () => {
    await expect(
      ReasoningService.processText({
        text: 'private note',
        systemPrompt: 'format this',
        routing: { isPrivateNote: true },
      }),
    ).resolves.toEqual({ text: 'local result', model: 'apple-fm' });

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockLocalProcessText).toHaveBeenCalledTimes(1);
  });

  it('throws and does not upload when local is unavailable and fallback is not allowed', async () => {
    mockGetReadiness.mockResolvedValue({ status: 'unavailable' });

    await expect(
      ReasoningService.processText({
        text: 'private note',
        systemPrompt: 'format this',
        routing: { isPrivateNote: true },
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_REASONING_UNAVAILABLE' });

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('falls through to cloud only when fallback is explicitly allowed', async () => {
    mockLocalProcessText.mockRejectedValue(new Error('native failed'));

    await expect(
      ReasoningService.processText({
        text: 'private note',
        systemPrompt: 'format this',
        routing: { isPrivateNote: true, allowCloudFallback: true },
      }),
    ).resolves.toEqual({ text: 'cloud result', model: 'cloud-model' });

    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to cloud once the request was cancelled', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    mockLocalProcessText.mockImplementation(async () => {
      controller.abort();
      throw cancelled;
    });

    await expect(
      ReasoningService.processText({
        text: 'private note',
        systemPrompt: 'format this',
        signal: controller.signal,
        routing: { isPrivateNote: true, allowCloudFallback: true },
      }),
    ).rejects.toBe(cancelled);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('keeps public signed-in requests on the cloud path', async () => {
    mockIsLocalRequired.mockReturnValue(false);

    await ReasoningService.processText({
      text: 'public note',
      systemPrompt: 'format this',
    });

    expect(mockLocalProcessText).not.toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('keeps hint-less callers (cleanup/agent) on cloud even when local would be required', async () => {
    mockIsLocalRequired.mockReturnValue(true);

    await expect(ReasoningService.processText({ text: 'raw dictation' })).resolves.toEqual({
      text: 'cloud result',
      model: 'cloud-model',
    });

    expect(mockLocalProcessText).not.toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

it('answers On-Device note chat on the device and never calls the Cloud API', async () => {
  await expect(
    ReasoningService.chatOverNote({
      inferenceRoute: { mode: 'local', scope: 'agent' },
      context: 'private meeting notes',
      question: 'what did we decide?',
      history: [],
    }),
  ).resolves.toEqual({ text: 'local result', model: 'apple-fm' });
  expect(mockLocalProcessText).toHaveBeenCalled();
  expect(mockPost).not.toHaveBeenCalled();
});

it('fails On-Device note chat rather than falling back to Cloud when the device cannot answer', async () => {
  mockGetReadiness.mockResolvedValue({ status: 'unavailable' });
  await expect(
    ReasoningService.chatOverNote({
      inferenceRoute: { mode: 'local', scope: 'agent' },
      context: 'private meeting notes',
      question: 'what did we decide?',
      history: [],
    }),
  ).rejects.toThrow();
  expect(mockPost).not.toHaveBeenCalled();
});

describe('On-Device cleanup output cap', () => {
  const localCleanup = {
    text: 'a dictation of about two thousand words',
    inferenceScope: 'cleanup' as const,
    inferenceRoute: { mode: 'local' as const, scope: 'cleanup' as const },
  };

  // The transcript fits the context, but its cleaned copy is as long and Apple Intelligence
  // would cut it off at the output cap without an error.
  it('refuses a cleanup whose reply would run past the output cap', async () => {
    mockFitsCleanupOutput.mockResolvedValue(false);

    await expect(ReasoningService.processText(localCleanup)).rejects.toMatchObject({
      code: 'LOCAL_CONTEXT_LIMIT',
    });

    expect(mockFitsCleanupOutput).toHaveBeenCalledWith(localCleanup.text);
    expect(mockLocalProcessText).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('cleans on the device when the reply fits', async () => {
    await expect(ReasoningService.processText(localCleanup)).resolves.toEqual({
      text: 'local result',
      model: 'apple-fm',
    });
  });

  it('goes to Cloud instead when the caller allowed it', async () => {
    mockFitsCleanupOutput.mockResolvedValue(false);

    await expect(
      ReasoningService.processText({
        text: 'long private note',
        systemPrompt: 'clean this',
        inferenceScope: 'cleanup',
        routing: { isPrivateNote: true, allowCloudFallback: true },
      }),
    ).resolves.toEqual({ text: 'cloud result', model: 'cloud-model' });

    expect(mockLocalProcessText).not.toHaveBeenCalled();
  });

  it('leaves notes, whose reply is shorter than what they read, to the context check', async () => {
    mockFitsCleanupOutput.mockResolvedValue(false);

    await ReasoningService.processText({
      text: 'long private note',
      systemPrompt: 'summarize this',
      inferenceScope: 'notes',
      routing: { isPrivateNote: true },
    });

    expect(mockFitsCleanupOutput).not.toHaveBeenCalled();
    expect(mockLocalProcessText).toHaveBeenCalledTimes(1);
  });
});
