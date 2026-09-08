// Per-provider budgets for the custom-dictionary STT prompt on the direct-API
// path, plus the decoder window the dictionary UI warns against. One place, so
// the request bound and the warning cannot drift apart.

// Groq rejects prompts > 896 chars (incl. when reached via a custom endpoint);
// 890 leaves margin for UTF-16 vs codepoint counting drift.
export const GROQ_PROMPT_CHARS = 890;

// Whisper-family decoders (whisper-1, Groq's whisper-large-v3, whisper.cpp) read
// at most 223 prompt tokens and keep the TAIL of anything longer, silently. 900
// chars is the historical client-side cut for them: it is well above what the
// decoder reads, so it only bounds the request, never which words survive.
export const WHISPER_PROMPT_CHARS = 900;

// What the decoder's 223-token window is actually worth in characters. A
// comma-separated list of names and technical terms tokenizes at ~2.3-2.9
// chars/token (measured against Whisper's own BPE) — far denser than the ~4
// chars/token rule of thumb for prose, because every ", " costs a token and
// rare proper nouns fragment. Used to warn in the UI, not to trim: the true
// budget is tokens, and no character count is right for every language.
export const WHISPER_DECODER_PROMPT_CHARS = 550;

// gpt-4o-transcribe / gpt-4o-mini-transcribe are LLMs, not Whisper decoders: no
// 223-token prompt window, and verified live to 40k chars. The only hard limit
// is the 16k-token context shared with the audio, so this is a guard against an
// absurd list crowding out a long dictation, not a limit anyone should hit.
export const TRANSCRIBE_PROMPT_CHARS = 8000;

// Only the 4o transcribe family is known to read past a Whisper decoder's
// prompt window, so it alone earns the generous budget. Everything else falls
// back to the Whisper budget on purpose: custom and self-hosted endpoints take
// whatever model name the user typed, and most of those servers are
// Whisper-family under a name that never says "whisper".
export function dictionaryPromptLimit({ provider = "", endpoint = "", model = "" } = {}) {
  if (provider === "groq" || endpoint.includes("api.groq.com")) return GROQ_PROMPT_CHARS;
  if (model.toLowerCase().startsWith("gpt-4o")) return TRANSCRIBE_PROMPT_CHARS;
  return WHISPER_PROMPT_CHARS;
}

// Cuts at the last comma inside the budget so no entry is sent half-spelled.
// Returns the (possibly shorter) prompt plus what changed, for logging.
// Callers must classify dictionary echoes against the returned prompt, not the
// original: the echo filter needs 70% of the prompt's words back, which a full
// echo of a trimmed prompt only clears when measured against the same string.
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
