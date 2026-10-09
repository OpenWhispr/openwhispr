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
// Whisper's echo pathology loops a term many times; saying a word twice is speech.
const LOOPED_WORD_MIN_OCCURRENCES = 3;
// Dictation almost never recites 3+ dictionary entries in the prompt's own order.
const MIN_CONSECUTIVE_TERM_RUN = 3;
// Whisper continues an initial prompt in the prompt's own shape: the hint list is
// joined with ", " (getCustomDictionaryPrompt), so a continuation arrives as a
// looped term, a short fragment left dangling on its separator ("testing, "), or
// a run of consecutive entries in the prompt's own order. Vocabulary overlap
// alone cannot stand in for that: short dictation is legitimately spelled out of
// dictionary words ("Electron, renderer"), and getDictionaryHintWords appends
// whole snippet triggers, so multi-word triggers put common words ("on", "my",
// "way") into the prompt and make plain speech look like an echo (#1889).
const PROMPT_DELIMITER_RE = /[,、，]/;
const TRAILING_DELIMITER_RE = /[,、，]\s*$/;

const hasLoopedWord = (textWords) => {
  const counts = new Map();
  for (const word of textWords) {
    const count = (counts.get(word) ?? 0) + 1;
    if (count >= LOOPED_WORD_MIN_OCCURRENCES) return true;
    counts.set(word, count);
  }
  return false;
};

// True when the text is MIN_CONSECUTIVE_TERM_RUN+ consecutive prompt entries in
// the prompt's own order — a literal continuation of the hint list, however long.
const matchesConsecutiveTermRun = (textWords, dictionaryPrompt) => {
  const promptSequence = [];
  let termIndex = 0;
  for (const term of dictionaryPrompt.split(PROMPT_DELIMITER_RE)) {
    const normalizedTerm = normalize(term);
    if (!normalizedTerm) continue;
    for (const word of normalizedTerm.split(" ")) {
      promptSequence.push({ word, termIndex });
    }
    termIndex++;
  }
  for (let start = 0; start + textWords.length <= promptSequence.length; start++) {
    let offset = 0;
    while (offset < textWords.length && promptSequence[start + offset].word === textWords[offset]) {
      offset++;
    }
    if (
      offset === textWords.length &&
      promptSequence[start + textWords.length - 1].termIndex -
        promptSequence[start].termIndex +
        1 >=
        MIN_CONSECUTIVE_TERM_RUN
    ) {
      return true;
    }
  }
  return false;
};

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

  // Shape tests run against the raw text: normalize() strips the separators.
  const continuesPromptShape =
    hasLoopedWord(textWords) ||
    (TRAILING_DELIMITER_RE.test(text) && normalizedText.length <= MAX_SHORT_FRAGMENT_CHARACTERS) ||
    (PROMPT_DELIMITER_RE.test(text) && matchesConsecutiveTermRun(textWords, dictionaryPrompt));

  return {
    isPromptFragment: matchCount / uniqueTextWords.size >= 0.9 && continuesPromptShape,
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

// Prompt-conditioned models can recite the hint list after the speech ends
// ("... Thanks, you. OpenWhispr, n8n."). matchesDictionaryPrompt cannot see
// that: the real speech dilutes its word ratios (#2581). The recited tail is a
// sentence of its own, made only of 2+ prompt entries in the prompt's own
// order, so that is the only shape removed. A sentence that ends on a single
// dictionary word, terms used inside speech, and a whole-text echo (left to
// matchesDictionaryPrompt) are untouched.
const MIN_TRAILING_ECHO_TERMS = 2;
// ASCII terminators need trailing whitespace so "Node.js" stays one term; the
// CJK ones do not, which also splits the Chinese script bias off its terms.
const SENTENCE_BREAK_RE = /[.!?]\s+|[。！？]\s*/g;
const PROMPT_TERM_BREAK_RE = /[,、，]|[.!?]\s+|[。！？]\s*/;

export function stripTrailingDictionaryEcho(text, dictionaryPrompt) {
  if (!text || !dictionaryPrompt) return text;

  const termIndexes = new Map();
  for (const term of dictionaryPrompt.split(PROMPT_TERM_BREAK_RE)) {
    const normalizedTerm = normalize(term);
    if (normalizedTerm && !termIndexes.has(normalizedTerm)) {
      termIndexes.set(normalizedTerm, termIndexes.size);
    }
  }

  const body = text.trimEnd();
  let tailStart = -1;
  for (const match of body.matchAll(SENTENCE_BREAK_RE)) {
    if (match.index + match[0].length < body.length) tailStart = match.index + match[0].length;
  }
  if (tailStart <= 0) return text;

  const tailTerms = body.slice(tailStart).split(PROMPT_DELIMITER_RE).map(normalize).filter(Boolean);
  if (tailTerms.length < MIN_TRAILING_ECHO_TERMS) return text;

  let previousIndex = null;
  for (const term of tailTerms) {
    const index = termIndexes.get(term);
    if (index === undefined) return text;
    if (previousIndex !== null && index !== previousIndex + 1) return text;
    previousIndex = index;
  }

  return body.slice(0, tailStart).trimEnd();
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
