import { buildProviderPrompt } from '../buildProviderPrompt';

it('builds cleanup prompts locally with language, dictionary, tone and agent-name substitution', () => {
  const prompt = buildProviderPrompt({
    text: 'um hello',
    language: 'fr',
    customDictionary: ['OpenWhispr'],
    tone: 'formal',
    agentName: 'Aria',
  });
  expect(prompt.systemPrompt).toContain('transcript cleanup engine');
  expect(prompt.systemPrompt).toContain('Aria');
  expect(prompt.systemPrompt).not.toContain('{{agentName}}');
  expect(prompt.systemPrompt).toContain('Prefer fr language conventions');
  expect(prompt.systemPrompt).toContain('OpenWhispr');
  expect(prompt.systemPrompt).toContain('formal, polished tone');
  expect(prompt.text).toBe(
    '<transcript>\num hello\n</transcript>\n\nOutput only the cleaned transcript.',
  );
});

it('keeps custom cleanup prompts as cleanup transforms with contextual instructions', () => {
  const prompt = buildProviderPrompt({
    text: 'hello',
    customPrompt: 'Be concise, {{agentName}}.',
    agentName: 'Aria',
    locale: 'de',
    tone: 'casual',
  });
  expect(prompt.systemPrompt).toContain('Be concise, Aria.');
  expect(prompt.systemPrompt).toContain('Prefer de language conventions');
  expect(prompt.systemPrompt).toContain('casual, conversational tone');
  expect(prompt.text).toContain('<transcript>');
});

it('preserves explicit action prompts and raw input without adding cleanup instructions', () => {
  expect(
    buildProviderPrompt({
      text: 'question',
      systemPrompt: 'Answer the question.',
      customPrompt: 'ignored',
      tone: 'excited',
      language: 'fr',
    }),
  ).toEqual({ systemPrompt: 'Answer the question.', text: 'question' });
});

it('uses the dictation action prompt for an addressed agent without wrapping its command as cleanup', () => {
  const prompt = buildProviderPrompt({
    text: 'Aria write a thank you note',
    agentName: 'Aria',
    inferenceScope: 'agent',
  });
  expect(prompt.systemPrompt).toContain('The user has addressed you by name with a command');
  expect(prompt.systemPrompt).toContain('Aria');
  expect(prompt.text).toBe('Aria write a thank you note');
});
