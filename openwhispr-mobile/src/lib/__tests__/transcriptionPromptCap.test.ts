import {
  GROQ_PROMPT_CHARS,
  TRANSCRIBE_PROMPT_CHARS,
  WHISPER_PROMPT_CHARS,
  dictionaryPromptLimit,
  trimDictionaryPrompt,
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

describe('trimDictionaryPrompt', () => {
  it('leaves a prompt within the budget untouched', (): void => {
    expect(trimDictionaryPrompt('OpenWhispr, Gizmo', 17)).toBe('OpenWhispr, Gizmo');
    expect(trimDictionaryPrompt('', 10)).toBe('');
  });

  it('cuts at the last comma inside the budget so no entry is half-spelled', (): void => {
    expect(trimDictionaryPrompt('alpha, bravo, charlie', 16)).toBe('alpha, bravo');
  });

  it('hard-cuts a single entry longer than the budget', (): void => {
    expect(trimDictionaryPrompt('supercalifragilistic', 5)).toBe('super');
  });
});
