import { createHash } from 'node:crypto';
import {
  AGENT_NAME_PLACEHOLDER,
  DEFAULT_CLEANUP_PROMPT,
  PROMPT_KIND_LIST,
  hasAgentNamePlaceholder,
  normalizeCustomPromptForSave,
  resolveCustomPrompt,
} from '@/config/prompts/registry';

// SHA-256 of the English cleanup prompt shipped by both the desktop app
// (src/locales/en/prompts.json) and the API (lib/locales/en/prompts.json).
// A stored custom prompt equal to this text must resolve to "" so that the
// server's future default updates still reach the install.
const SHIPPED_CLEANUP_PROMPT_SHA256 =
  '58ed65fbc679a7bac1483ef850c51ac7932a02d17fab9ca688f4d11f6aa9b7e6';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('prompt registry', () => {
  it('ships the same default cleanup prompt as desktop and the API, byte for byte', () => {
    expect(sha256(DEFAULT_CLEANUP_PROMPT)).toBe(SHIPPED_CLEANUP_PROMPT_SHA256);
  });

  it('keeps exactly one agent-name placeholder in the default cleanup prompt', () => {
    const occurrences = DEFAULT_CLEANUP_PROMPT.split(AGENT_NAME_PLACEHOLDER).length - 1;
    expect(occurrences).toBe(1);
  });

  it('mirrors the desktop prompt kinds so a future sync can round-trip every kind', () => {
    expect(PROMPT_KIND_LIST).toEqual(['cleanup', 'dictationAgent', 'translate', 'chatAgent']);
  });
});

describe('hasAgentNamePlaceholder', () => {
  it('detects the placeholder anywhere in the text', () => {
    expect(hasAgentNamePlaceholder('Mentions of "{{agentName}}" are dictated words.')).toBe(true);
  });

  it('is false when the user removed the placeholder', () => {
    expect(hasAgentNamePlaceholder('Clean the transcript. Mentions of the agent are words.')).toBe(
      false,
    );
  });
});

describe('normalizeCustomPromptForSave', () => {
  const defaultText = 'Default prompt text.';

  it('stores "" for an empty draft', () => {
    expect(normalizeCustomPromptForSave('', defaultText)).toBe('');
  });

  it('stores "" for a whitespace-only draft', () => {
    expect(normalizeCustomPromptForSave('  \n\t ', defaultText)).toBe('');
  });

  it('stores "" when the draft equals the shipped default, so it is not a customization', () => {
    expect(normalizeCustomPromptForSave(defaultText, defaultText)).toBe('');
  });

  it('keeps a one-character edit of the default as a customization', () => {
    expect(normalizeCustomPromptForSave(`${defaultText}.`, defaultText)).toBe(`${defaultText}.`);
  });

  it('preserves the draft verbatim, including surrounding whitespace', () => {
    const draft = '  Always use bullet points.\n\n';
    expect(normalizeCustomPromptForSave(draft, defaultText)).toBe(draft);
  });
});

describe('resolveCustomPrompt', () => {
  it('treats "" and whitespace-only stored values as "no override"', () => {
    expect(resolveCustomPrompt('')).toBeUndefined();
    expect(resolveCustomPrompt(' \n\t')).toBeUndefined();
  });

  it('returns any other stored value verbatim', () => {
    expect(resolveCustomPrompt('  Verbatim.  ')).toBe('  Verbatim.  ');
  });
});
