import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { api } from '@/lib/apiClient';

jest.mock('@/lib/apiClient', () => ({
  api: {
    post: jest.fn(async () => ({ text: 'out', model: 'm', provider: 'cloud', processingMs: 1 })),
  },
}));

const mockPost = api.post as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('ReasoningService agentName on the wire', () => {
  it('sends agentName when provided', async () => {
    await ReasoningService.processText({ text: 'hi', language: 'en', agentName: 'OpenWhispr' });
    expect((mockPost.mock.calls[0][1] as Record<string, unknown>).agentName).toBe('OpenWhispr');
  });

  it('omits agentName when not provided', async () => {
    await ReasoningService.processText({ text: 'hi', language: 'en' });
    expect((mockPost.mock.calls[0][1] as Record<string, unknown>).agentName).toBeUndefined();
  });

  it('sends agentName even when a systemPrompt override is provided', async () => {
    // Action Mode takes precedence over system-prompt override; the server handles routing.
    await ReasoningService.processText({
      text: 'hi',
      systemPrompt: 'custom',
      agentName: 'Aria',
    });
    const body = mockPost.mock.calls[0][1] as Record<string, unknown>;
    expect(body.agentName).toBe('Aria');
  });
});
