const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

export function matchesDictionaryPrompt(text, dictionaryPrompt) {
  if (!text || !dictionaryPrompt) return false;

  const normalizedText = normalize(text);
  const normalizedPrompt = normalize(dictionaryPrompt);

  if (!normalizedText || !normalizedPrompt) return false;

  if (normalizedText === normalizedPrompt) return true;

  const dictWords = new Set(normalizedPrompt.split(" "));
  const uniqueTextWords = new Set(normalizedText.split(" "));

  let matchCount = 0;
  for (const word of uniqueTextWords) {
    if (dictWords.has(word)) matchCount++;
  }

  const textComposition = matchCount / uniqueTextWords.size;
  const dictionaryUsage = matchCount / dictWords.size;

  return textComposition >= 0.9 && dictionaryUsage >= 0.7;
}

// Request-side caps for the dictionary hint prompt, mirrored here so the echo
// check can reconstruct exactly what was sent (#1636). Groq rejects prompts
// > 896 chars (890 leaves margin for UTF-16 vs codepoint counting drift);
// everything else is capped at 900.
export const GROQ_MAX_PROMPT_CHARS = 890;
export const DEFAULT_MAX_PROMPT_CHARS = 900;
const SENT_PROMPT_CAPS = [GROQ_MAX_PROMPT_CHARS, DEFAULT_MAX_PROMPT_CHARS];

export function truncateDictionaryPrompt(prompt, maxChars) {
  if (!prompt || prompt.length <= maxChars) return prompt;
  const truncated = prompt.slice(0, maxChars);
  const lastComma = truncated.lastIndexOf(",");
  return lastComma > 0 ? truncated.slice(0, lastComma) : truncated;
}

// A capped request sends only a prefix of the dictionary join, so an echo of
// what the recognizer was actually primed with has dictionaryUsage bounded by
// roughly sentChars / joinChars against the full join — once the dictionary
// meaningfully exceeds the cap, a perfect echo of the sent prompt can never
// clear the 0.7 threshold (#1636). Compare against the sent-size prefixes as
// well as the full prompt, which still covers paths that send it whole.
export function matchesSentDictionaryPrompt(text, prompt) {
  if (matchesDictionaryPrompt(text, prompt)) return true;
  return SENT_PROMPT_CAPS.some((cap) => {
    const truncated = truncateDictionaryPrompt(prompt, cap);
    return truncated !== prompt && matchesDictionaryPrompt(text, truncated);
  });
}

export const DICTIONARY_ECHO_CODE = "DICTIONARY_ECHO";

// Keeps the "No audio detected" message so the existing message comparisons and
// the main-process no-audio contract still match, while letting the pipeline
// tell a discarded dictionary echo apart from genuine silence (#1547).
export function dictionaryEchoError() {
  const error = new Error("No audio detected");
  error.code = DICTIONARY_ECHO_CODE;
  return error;
}
