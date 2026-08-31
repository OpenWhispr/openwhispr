const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const EMPTY_FRAGMENT_ANALYSIS = Object.freeze({
  isPromptFragment: false,
  hasRepeatedWords: false,
  uniqueWordCount: 0,
});
const MAX_SHORT_FRAGMENT_CHARACTERS = 30;

export function analyzeDictionaryPromptFragment(text, dictionaryPrompt) {
  if (!text || !dictionaryPrompt) return EMPTY_FRAGMENT_ANALYSIS;

  const normalizedText = normalize(text);
  const normalizedPrompt = normalize(dictionaryPrompt);

  if (!normalizedText || !normalizedPrompt) return EMPTY_FRAGMENT_ANALYSIS;

  const textWords = normalizedText.split(" ");
  const promptWords = new Set(normalizedPrompt.split(" "));
  const uniqueTextWords = new Set(textWords);
  const hasRepeatedWords = textWords.length > uniqueTextWords.size;
  let matchCount = 0;

  for (const word of uniqueTextWords) {
    if (promptWords.has(word)) matchCount++;
  }

  return {
    isPromptFragment:
      matchCount / uniqueTextWords.size >= 0.9 &&
      (normalizedText.length <= MAX_SHORT_FRAGMENT_CHARACTERS || hasRepeatedWords),
    hasRepeatedWords,
    uniqueWordCount: uniqueTextWords.size,
  };
}

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

export function isLikelyDictionaryPromptFragment(text, dictionaryPrompt) {
  return analyzeDictionaryPromptFragment(text, dictionaryPrompt).isPromptFragment;
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
