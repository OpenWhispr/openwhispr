import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { api } from '@/lib/apiClient';

jest.mock('@/lib/apiClient', () => ({
  api: {
    post: jest.fn(async () => ({ text: 'out', model: 'm', provider: 'cloud', processingMs: 1 })),
  },
}));

const mockPost = api.post as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('ReasoningService tone on the wire', () => {
  it('sends tone for a non-default cleanup request', async () => {
    await ReasoningService.processText({ text: 'hi', language: 'en', tone: 'formal' });
    expect((mockPost.mock.calls[0][1] as Record<string, unknown>).tone).toBe('formal');
  });

  it('omits tone for the default tone', async () => {
    await ReasoningService.processText({ text: 'hi', language: 'en', tone: 'default' });
    expect((mockPost.mock.calls[0][1] as Record<string, unknown>).tone).toBeUndefined();
  });

  it('omits tone when a systemPrompt override is provided', async () => {
    await ReasoningService.processText({ text: 'hi', systemPrompt: 'custom', tone: 'excited' });
    const body = mockPost.mock.calls[0][1] as Record<string, unknown>;
    expect(body.tone).toBeUndefined();
    expect(body.systemPrompt).toBe('custom');
  });
});
