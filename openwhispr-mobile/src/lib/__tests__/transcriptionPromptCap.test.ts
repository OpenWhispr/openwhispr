import {
  GROQ_PROMPT_CHARS,
  TRANSCRIBE_PROMPT_CHARS,
  WHISPER_DECODER_PROMPT_CHARS,
  WHISPER_PROMPT_CHARS,
  dictionaryPromptLimit,
  formatDictionaryPrompt,
  promptLimitKeepingPersonal,
  sharedDictionaryPromptChars,
} from '../transcriptionPromptCap';

describe('dictionaryPromptLimit', () => {
  it('caps Groq by provider id and by a custom endpoint on api.groq.com', (): void => {
    expect(
      dictionaryPromptLimit({
        providerId: 'groq',
        endpoint: 'https://api.groq.com/openai/v1',
        modelId: 'whisper-large-v3-turbo',
      }),
    ).toBe(GROQ_PROMPT_CHARS);
    expect(
      dictionaryPromptLimit({
        providerId: 'custom',
        endpoint: 'https://api.groq.com/openai/v1',
        modelId: 'gpt-4o-transcribe',
      }),
    ).toBe(GROQ_PROMPT_CHARS);
  });

  it('matches Groq by host, not by a substring anywhere in the URL', (): void => {
    expect(
      dictionaryPromptLimit({
        providerId: 'custom',
        endpoint: 'https://api.groq.com.example.net/v1',
        modelId: 'whisper-1',
      }),
    ).toBe(WHISPER_PROMPT_CHARS);
  });

  it('gives gpt-4o transcribe models the generous budget, case-insensitively', (): void => {
    expect(
      dictionaryPromptLimit({
        providerId: 'openai',
        endpoint: 'https://api.openai.com/v1',
        modelId: 'GPT-4o-mini-transcribe',
      }),
    ).toBe(TRANSCRIBE_PROMPT_CHARS);
  });

  it('falls back to the Whisper budget for everything else', (): void => {
    expect(
      dictionaryPromptLimit({
        providerId: 'openai',
        endpoint: 'https://api.openai.com/v1',
        modelId: 'whisper-1',
      }),
    ).toBe(WHISPER_PROMPT_CHARS);
    expect(
      dictionaryPromptLimit({
        providerId: 'custom',
        endpoint: 'http://192.168.1.10:8080/v1',
        modelId: 'large-v3',
      }),
    ).toBe(WHISPER_PROMPT_CHARS);
  });
});

describe('formatDictionaryPrompt', () => {
  it('leaves a personal-only list that fits unchanged', (): void => {
    expect(formatDictionaryPrompt([['a', 'b'], [], []], 900)).toBe('a, b');
  });

  it('ends with personal words when over budget', (): void => {
    const workspace = Array.from({ length: 300 }, (_, i) => `ws${String(i).padStart(8, '0')}`);
    const prompt = formatDictionaryPrompt([['Piha', 'Biscuit'], [], workspace], 900);
    expect(prompt.endsWith('Piha, Biscuit')).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(900);
    expect(prompt.length).toBeGreaterThan(800);
    const words = prompt.split(', ');
    // The highest-priority workspace words are kept, in their own order.
    expect(words[0]).toBe('ws00000000');
    expect(words.indexOf('Piha')).toBeGreaterThan(words.findIndex((w) => w.startsWith('ws')));
  });

  it('keeps the higher tier last and drops whole words only', (): void => {
    expect(formatDictionaryPrompt([['P1'], ['S1'], ['W1']], 100)).toBe('W1, S1, P1');
    // 9 characters fit "S1, P1" and nothing more: W1 is dropped, not truncated.
    expect(formatDictionaryPrompt([['P1'], ['S1'], ['W1']], 9)).toBe('S1, P1');
  });

  it('stops at the first word that does not fit', (): void => {
    expect(formatDictionaryPrompt([['P1'], ['longer-space-word', 'S2'], ['W1']], 12)).toBe('P1');
  });

  it('returns an empty string for empty tiers', (): void => {
    expect(formatDictionaryPrompt([[], [], []], 900)).toBe('');
  });

  // BYOK sends formatDictionaryPrompt(tiers, dictionaryPromptLimit(route)) as is. Unlike the
  // trimDictionaryPrompt it replaced, a word ending exactly on the budget is kept.
  it('keeps a word that ends exactly on the budget', (): void => {
    expect(formatDictionaryPrompt([['P1', 'S1', 'W1'], [], []], 6)).toBe('P1, S1');
  });

  // As trimDictionaryPrompt did: the head of the first entry, cut at its last comma if any.
  it('sends the first personal entry cut off when it alone is over the budget', (): void => {
    expect(formatDictionaryPrompt([['Kubernetes', 'k8s'], ['S1'], []], 4)).toBe('Kube');
    expect(formatDictionaryPrompt([['P1'], ['S1'], ['W1']], 1)).toBe('P');
    expect(formatDictionaryPrompt([['ab,cdefgh'], [], []], 5)).toBe('ab');
    // The same cases desktop's dictionaryPromptCap tests pin.
    expect(formatDictionaryPrompt([['x'.repeat(1000)], [], []], 890)).toBe('x'.repeat(890));
    expect(formatDictionaryPrompt([['Smith, John, Doe'], [], []], 13)).toBe('Smith, John');
    // A comma at index 0 is not a cut point.
    expect(formatDictionaryPrompt([[',abcdef'], [], []], 4)).toBe(',abc');
    expect(formatDictionaryPrompt([['Kubernetes'], [], []], 0)).toBe('');
  });

  it('never cuts a shared word', (): void => {
    expect(formatDictionaryPrompt([[], ['Kubernetes'], []], 4)).toBe('');
  });

  it('stops the shared fill at sharedChars but keeps personal words to maxChars', (): void => {
    const tiers = [['P1'], ['S1', 'S2'], ['W1']];
    expect(formatDictionaryPrompt(tiers, 100, { sharedChars: 10 })).toBe('S1, S2, P1');
    expect(formatDictionaryPrompt(tiers, 100, { sharedChars: 9 })).toBe('S1, P1');
    // Personal words past sharedChars still fit; no shared word joins them.
    expect(formatDictionaryPrompt([['Piha', 'Biscuit'], ['S1'], []], 100, { sharedChars: 5 })).toBe(
      'Piha, Biscuit',
    );
  });

  it('stops the shared fill at sharedWords, space words first', (): void => {
    expect(formatDictionaryPrompt([['P1'], ['S1', 'S2'], ['W1']], 100, { sharedWords: 2 })).toBe(
      'S1, S2, P1',
    );
    expect(formatDictionaryPrompt([['P1'], ['S1'], ['W1', 'W2']], 100, { sharedWords: 2 })).toBe(
      'W1, S1, P1',
    );
  });

  it('stops the shared fill at totalTerms, counting the terms inside a personal entry', (): void => {
    // "Smith, John" is two terms to a provider that splits the prompt on commas.
    expect(
      formatDictionaryPrompt([['Smith, John', 'P2'], ['S1', 'S2'], []], 100, { totalTerms: 4 }),
    ).toBe('S1, Smith, John, P2');
  });

  it('never drops a personal word for the shared caps', (): void => {
    const personal = Array.from({ length: 150 }, (_, i) => `p${i}`);
    expect(
      formatDictionaryPrompt([personal, ['S1'], []], 10_000, {
        sharedChars: 5,
        sharedWords: 0,
        totalTerms: 100,
      }),
    ).toBe(personal.join(', '));
  });
});

describe('sharedDictionaryPromptChars', () => {
  it('caps Whisper-style budgets at the decoder window', (): void => {
    expect(sharedDictionaryPromptChars(WHISPER_PROMPT_CHARS)).toBe(WHISPER_DECODER_PROMPT_CHARS);
    expect(sharedDictionaryPromptChars(GROQ_PROMPT_CHARS)).toBe(WHISPER_DECODER_PROMPT_CHARS);
    expect(sharedDictionaryPromptChars(400)).toBe(400);
  });

  it('keeps budgets the model reads whole', (): void => {
    expect(sharedDictionaryPromptChars(TRANSCRIBE_PROMPT_CHARS)).toBe(TRANSCRIBE_PROMPT_CHARS);
  });
});

describe('promptLimitKeepingPersonal', () => {
  it('keeps the limit when the personal tier fits in it', (): void => {
    expect(promptLimitKeepingPersonal([['Piha', 'Biscuit'], ['S1'], []], 890)).toBe(890);
  });

  it('grows to the personal tier so personal words are never cut', (): void => {
    const personal = Array.from({ length: 200 }, (_, i) => `personal${i}`);
    const limit = promptLimitKeepingPersonal([personal, ['S1'], ['W1']], 890);
    expect(limit).toBe(personal.join(', ').length);
    expect(formatDictionaryPrompt([personal, ['S1'], ['W1']], limit)).toBe(personal.join(', '));
  });
});
