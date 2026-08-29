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

// A provider that never received the dictionary can't echo it back: the echo
// check only applies when the outgoing payload actually carried dictionary
// bias (Tinfoil's `prompt`, Mistral's `contextBias`, xAI/Gemini's `keyterms`).
// Corti's payload has none of these, so the check is skipped there (#1759).
export function payloadSendsDictionaryBias(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (typeof payload.prompt === "string" && payload.prompt.trim()) return true;
  if (Array.isArray(payload.contextBias) && payload.contextBias.length > 0) return true;
  if (Array.isArray(payload.keyterms) && payload.keyterms.length > 0) return true;
  return false;
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
