import { AppleLLM } from '@/lib/appleLLM';
import { LocalReasoningService } from '../LocalReasoningService';

jest.mock('@/lib/appleLLM', () => ({
  AppleLLM: { generateText: jest.fn(), countTokens: jest.fn(async () => null) },
}));

const mockGenerateText = AppleLLM.generateText as jest.Mock;
const mockCountTokens = AppleLLM.countTokens as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

it('passes the caller signal to Apple Intelligence so a timeout stops the run', async () => {
  mockGenerateText.mockResolvedValue({ text: ' Hello. ', model: 'apple-foundation-models' });
  const { signal } = new AbortController();

  await expect(
    LocalReasoningService.processText({ text: 'um hello', systemPrompt: 'Clean up.', signal }),
  ).resolves.toEqual({ text: 'Hello.', model: 'apple-fm' });
  expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'um hello' }), {
    signal,
  });
});

it('reports an aborted run as a cancelled local request', async () => {
  mockGenerateText.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'AbortError' }));

  await expect(
    LocalReasoningService.processText({ text: 'um hello', systemPrompt: 'Clean up.' }),
  ).rejects.toMatchObject({ name: 'LocalReasoningError', code: 'APPLE_LLM_CANCELLED' });
});

// The On-Device cleanup timeout assumes a generation rate; dev builds log the measured one.
describe('dev log', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(2_000);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports output tokens per second', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Hello.', model: 'apple-foundation-models' });
    mockCountTokens.mockResolvedValueOnce(50);

    await LocalReasoningService.processText({ text: 'um hello', systemPrompt: 'Clean up.' });

    expect(mockCountTokens).toHaveBeenCalledWith({ prompt: 'Hello.' });
    expect(log).toHaveBeenCalledWith(
      '[reasoning] provider=local model=apple-fm elapsedMs=2000 outputTokens=50 tokensPerSecond=25.0',
    );
  });

  it('marks the count as estimated where iOS cannot count tokens', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Hello there.', model: 'apple-foundation-models' });

    await LocalReasoningService.processText({ text: 'um hello', systemPrompt: 'Clean up.' });

    expect(log).toHaveBeenCalledWith(
      '[reasoning] provider=local model=apple-fm elapsedMs=2000 outputTokens=4 (estimated) tokensPerSecond=2.0',
    );
  });
});
