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
  fitsLocalReasoningBudget,
  getLocalReasoningReadiness,
  isLocalReasoningRequired,
} from '@/lib/localReasoning';
import { LocalReasoningService } from '@/services/reasoning/LocalReasoningService';

const mockPost = api.post as jest.Mock;
const mockIsLocalRequired = isLocalReasoningRequired as jest.Mock;
const mockGetReadiness = getLocalReasoningReadiness as jest.Mock;
const mockFitsBudget = fitsLocalReasoningBudget as jest.Mock;
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
