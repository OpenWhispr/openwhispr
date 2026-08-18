// Per-provider budgets for the custom-dictionary STT prompt. One place, so the
// direct-API path, the local whisper-server path and the dictionary UI agree on
// where the list gets cut and which end survives.

// Groq rejects prompts > 896 chars (incl. when reached via a custom endpoint);
// 890 leaves margin for UTF-16 vs codepoint counting drift.
export const GROQ_PROMPT_CHARS = 890;

// Whisper-family decoders (whisper-1, whisper.cpp) read at most 224 prompt
// tokens, roughly 900 chars. Past that they silently keep only one end of the
// list (OpenAI and whisper.cpp both keep the tail), so we trim client-side and
// keep the head: the top of the user's list is what wins, everywhere.
export const WHISPER_PROMPT_CHARS = 900;

// gpt-4o-transcribe / gpt-4o-mini-transcribe accept far longer prompts (verified
// live to 40k chars); the only hard limit is the 16k-token context shared with
// the audio (~8 tokens/s) and a 2k output reserve. ~1.7k tokens of dictionary
// leaves room for long dictations while never touching a real-world list.
export const TRANSCRIBE_PROMPT_CHARS = 8000;

export function dictionaryPromptLimit({ provider = "", endpoint = "", model = "" } = {}) {
  if (provider === "groq" || endpoint.includes("api.groq.com")) return GROQ_PROMPT_CHARS;
  if (model.toLowerCase().includes("whisper")) return WHISPER_PROMPT_CHARS;
  return TRANSCRIBE_PROMPT_CHARS;
}

// Cuts at the last comma inside the budget so no entry is sent half-spelled.
// Returns the (possibly shorter) prompt plus what changed, for logging.
export function trimDictionaryPrompt(prompt, maxChars) {
  if (!prompt || prompt.length <= maxChars) {
    return { prompt, originalLength: prompt ? prompt.length : 0, truncated: false };
  }
  const head = prompt.slice(0, maxChars);
  const lastComma = head.lastIndexOf(",");
  return {
    prompt: lastComma > 0 ? head.slice(0, lastComma) : head,
    originalLength: prompt.length,
    truncated: true,
  };
}
