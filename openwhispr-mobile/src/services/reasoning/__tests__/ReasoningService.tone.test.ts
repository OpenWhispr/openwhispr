jest.mock('@/lib/inferenceRouting', () => ({ getInferenceSelection: jest.fn(() => undefined) }));

import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { api } from '@/lib/apiClient';
import { buildProviderPrompt } from '@/services/reasoning/buildProviderPrompt';

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

  it('sends the kind of app with a tone', async () => {
    await ReasoningService.processText({ text: 'hi', tone: 'casual', appCategory: 'email' });
    const body = mockPost.mock.calls[0][1] as Record<string, unknown>;
    expect(body.tone).toBe('casual');
    expect(body.appCategory).toBe('email');
  });

  it('never sends the kind of app without a tone', async () => {
    await ReasoningService.processText({ text: 'hi', tone: 'default', appCategory: 'work' });
    expect((mockPost.mock.calls[0][1] as Record<string, unknown>).appCategory).toBeUndefined();
  });
});

describe('provider cleanup prompt with a kind of app', () => {
  it('says what the text is before the tone, as the server does', () => {
    const { systemPrompt } = buildProviderPrompt({
      text: 'hi',
      tone: 'formal',
      appCategory: 'email',
    });
    const last = systemPrompt.split('\n\n').pop() ?? '';
    expect(last.startsWith('The text is an email.')).toBe(true);
    expect(last).toContain('Apply this tone: formal');
    expect(last).toContain('This tone overrides');
  });

  it('adds nothing for other apps or without a tone', () => {
    expect(
      buildProviderPrompt({ text: 'hi', tone: 'formal', appCategory: 'other' }).systemPrompt,
    ).toBe(buildProviderPrompt({ text: 'hi', tone: 'formal' }).systemPrompt);
    expect(buildProviderPrompt({ text: 'hi', appCategory: 'email' }).systemPrompt).toBe(
      buildProviderPrompt({ text: 'hi' }).systemPrompt,
    );
  });

  it('drops the tone and the kind of app under a custom prompt', () => {
    const { systemPrompt } = buildProviderPrompt({
      text: 'hi',
      tone: 'casual',
      appCategory: 'personal',
      customPrompt: 'Clean this.',
    });
    expect(systemPrompt).not.toContain('personal chat message');
  });
});
