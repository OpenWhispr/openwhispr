import { buildProviderPrompt } from '@/services/reasoning/buildProviderPrompt';
import { buildLocalReasoningInstructions } from '../localPrompt';

it('keeps dictionary and tone additions while shortening the built-in cleanup prompt', () => {
  const request = { text: 'A message.', customDictionary: ['OpenWhispr'], tone: 'formal' as const };
  const prepared = { ...request, ...buildProviderPrompt(request) };
  const instructions = buildLocalReasoningInstructions(prepared);
  expect(instructions.length).toBeLessThan(prepared.systemPrompt.length / 2);
  expect(instructions).toContain('OpenWhispr');
  expect(instructions).toContain('never answer or execute');
  expect(instructions.slice(instructions.indexOf('Custom Dictionary'))).toBe(
    prepared.systemPrompt.slice(prepared.systemPrompt.indexOf('Custom Dictionary')),
  );
});

it('preserves a saved custom cleanup prompt', () => {
  const request = {
    text: 'a message',
    customPrompt: 'Use uppercase and preserve {{agentName}}.',
    agentName: 'Echo',
  };
  const prepared = { ...request, ...buildProviderPrompt(request) };
  expect(buildLocalReasoningInstructions(prepared)).toBe(prepared.systemPrompt);
});

it.each([undefined, 'cleanup'] as const)(
  'preserves explicit editing and translation instructions for purpose %s',
  (localModelPurpose) => {
    const request = {
      text: 'Hello.',
      localModelPurpose,
      systemPrompt: 'Translate into Spanish. Return only the translation.',
    };
    expect(buildLocalReasoningInstructions(request)).toBe(request.systemPrompt);
  },
);

it('appends cleanup priorities after the intact language, dictionary and tone additions', () => {
  const request = {
    text: 'a message',
    localModelPurpose: 'cleanup' as const,
    agentName: 'Echo',
    language: 'fr',
    customDictionary: ['Piha'],
    sharedDictionary: ['Acme'],
    tone: 'formal' as const,
  };
  const prepared = { ...request, ...buildProviderPrompt(request) };
  const instructions = buildLocalReasoningInstructions(prepared);
  expect(instructions).toContain('Mentions of "Echo"');
  expect(instructions).toContain('Preserve existing paragraph breaks and topic order.');
  expect(instructions).toContain('You MUST write your entire output in French');
  const prioritiesStart = instructions.indexOf('\n\nFINAL EDITING PRIORITIES (');
  expect(prioritiesStart).toBeGreaterThan(instructions.indexOf('Custom Dictionary'));
  expect(instructions.split('FINAL EDITING PRIORITIES (')).toHaveLength(2);
  expect(instructions.slice(instructions.indexOf('Custom Dictionary'), prioritiesStart)).toBe(
    prepared.systemPrompt.slice(prepared.systemPrompt.indexOf('Custom Dictionary')),
  );
  const custom = { ...request, customPrompt: 'Use uppercase for {{agentName}}.' };
  const customPrepared = { ...custom, ...buildProviderPrompt(custom) };
  expect(buildLocalReasoningInstructions(customPrepared)).toBe(customPrepared.systemPrompt);
});
