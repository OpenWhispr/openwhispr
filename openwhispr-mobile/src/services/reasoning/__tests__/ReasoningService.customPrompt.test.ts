import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { api } from '@/lib/apiClient';

jest.mock('@/lib/apiClient', () => ({
  api: {
    post: jest.fn(async () => ({ text: 'out', model: 'm', provider: 'cloud', processingMs: 1 })),
  },
}));

const mockPost = api.post as jest.Mock;

const lastBody = (): Record<string, unknown> =>
  mockPost.mock.calls[0][1] as Record<string, unknown>;

beforeEach(() => jest.clearAllMocks());

// The API treats `customPrompt` as a template it substitutes {{agentName}}
// into and still appends language, dictionary and tone; `promptMode: 'cleanup'`
// pins cleanup semantics (transcript wrapper, temperature 0, cleanup model).
// `systemPrompt` is a raw action-mode override and must win outright.
describe('ReasoningService custom cleanup prompt on the wire', () => {
  it('sends customPrompt with promptMode cleanup and keeps the server-side resolution fields', async () => {
    await ReasoningService.processText({
      text: 'hi',
      customPrompt: 'Be terse, {{agentName}}.',
      language: 'en',
      locale: 'en',
      customDictionary: ['Whispr'],
      tone: 'formal',
      agentName: 'Aria',
    });
    const body = lastBody();
    expect(body.customPrompt).toBe('Be terse, {{agentName}}.');
    expect(body.promptMode).toBe('cleanup');
    expect(body.language).toBe('en');
    expect(body.locale).toBe('en');
    expect(body.customDictionary).toEqual(['Whispr']);
    expect(body.tone).toBe('formal');
    expect(body.agentName).toBe('Aria');
  });

  it('omits both fields when no custom prompt is set', async () => {
    await ReasoningService.processText({ text: 'hi', language: 'en' });
    const body = lastBody();
    expect(body).not.toHaveProperty('customPrompt');
    expect(body).not.toHaveProperty('promptMode');
  });

  it('lets a systemPrompt override win over a custom prompt', async () => {
    await ReasoningService.processText({
      text: 'hi',
      systemPrompt: 'raw override',
      customPrompt: 'ignored',
    });
    const body = lastBody();
    expect(body.systemPrompt).toBe('raw override');
    expect(body).not.toHaveProperty('customPrompt');
    expect(body).not.toHaveProperty('promptMode');
  });
});
