// Per-provider budgets for the custom-dictionary transcription prompt.
// Groq rejects prompts > 896 chars (also via a custom endpoint); 890 leaves margin.
export const GROQ_PROMPT_CHARS = 890;
// Whisper-family decoders read at most 223 prompt tokens and keep the tail of
// anything longer; 900 chars bounds the request without deciding which words survive.
export const WHISPER_PROMPT_CHARS = 900;
// gpt-4o-transcribe models are LLMs with a 16k context; this guards against an
// absurd list crowding out a long dictation, not a limit anyone should hit.
export const TRANSCRIBE_PROMPT_CHARS = 8000;

export function dictionaryPromptLimit(input: {
  providerId: string;
  endpoint: string;
  modelId: string;
}): number {
  if (input.providerId === 'groq' || input.endpoint.includes('api.groq.com')) {
    return GROQ_PROMPT_CHARS;
  }
  if (input.modelId.toLowerCase().startsWith('gpt-4o')) return TRANSCRIBE_PROMPT_CHARS;
  return WHISPER_PROMPT_CHARS;
}

// Cuts at the last comma inside the budget so no entry is sent half-spelled.
export function trimDictionaryPrompt(prompt: string, maxChars: number): string {
  if (prompt.length <= maxChars) return prompt;
  const head = prompt.slice(0, maxChars);
  const lastComma = head.lastIndexOf(',');
  return lastComma > 0 ? head.slice(0, lastComma) : head;
}
