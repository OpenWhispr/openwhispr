// Filler-word removal. Runs on every transcript before the optional LLM cleanup
// and before paste, so it must stay pure and cheap: no model call, no I/O.
// ESM named exports, matching the other renderer-reachable helpers audioManager
// already imports (dictationRouting.js, discardedRecording.js, localSpeechGate.js).
// A `module.exports` here throws "module is not defined" under Vite/SSR, which is
// how the renderer loads this file.

export const DEFAULT_FILLER_WORDS = [
  "um",
  "uh",
  "er",
  "ah",
  "eh",
  "umm",
  "uhh",
  "err",
  "ahh",
  "ehh",
  "hmm",
  "hm",
  "mm",
  "mmm",
  "erm",
  "urm",
  "ugh",
];

// Word characters, Unicode-aware: \b is ASCII-only and would split "über"
// mid-word. A filler only counts when neither side is a letter, digit, or mark
// — that is what keeps "summer" and "humm" intact. Both boundaries are
// lookarounds rather than consumed characters, so a run of adjacent fillers
// ("does it, um... uh work") matches as one unit instead of the first match
// eating the boundary the second one needs.
const WORD_CHAR = "\\p{L}\\p{N}\\p{M}";
// Soft separators a filler drags along with it: commas and dashes on either
// side, so "But, uh, does it" leaves no stray comma. Sentence punctuation is
// handled separately below because it carries meaning the filler does not.
const SOFT_CHARS = ",\\-\\u2013\\u2014";
// Sentence-ending punctuation that may trail a filler ("hmm?", "um...").
const END_CHARS = ".;:!?\\u2026";

function escapeForRegex(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Trimmed, lowercased, de-duplicated; empty and non-string entries dropped.
function normalizeWords(words) {
  if (!Array.isArray(words)) return [];
  const seen = new Set();
  for (const word of words) {
    if (typeof word !== "string") continue;
    const trimmed = word.trim().toLowerCase();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

export function removeFillerWords(text, words = DEFAULT_FILLER_WORDS) {
  if (typeof text !== "string" || text.length === 0) return text;

  const list = normalizeWords(words);
  if (list.length === 0) return text;

  const alternation = list.map(escapeForRegex).join("|");
  // One filler plus the soft separators and spaces that trail it.
  const unit = `(?<![${WORD_CHAR}])(?:${alternation})(?![${WORD_CHAR}])[${SOFT_CHARS}\\s]*`;
  // Groups: 1 = soft separators leading INTO the run (absorbed), 2 = the run,
  // 3 = sentence punctuation trailing the run, 4 = space after that.
  const pattern = new RegExp(`([${SOFT_CHARS}\\s]*)((?:${unit})+)([${END_CHARS}]*)(\\s*)`, "giu");

  let removedAtStart = false;
  const stripped = text.replace(pattern, (match, lead, run, end, tail, offset) => {
    const before = text.slice(0, offset + lead.length).trimEnd();
    if (before.length === 0) removedAtStart = true;
    // The filler opened the text or a sentence: the break already exists, so
    // the filler goes with everything attached to it ("Okay. Um, so" -> "Okay. So").
    const atSentenceStart = before.length === 0 || /[.;:!?\u2026]$/u.test(before);
    if (atSentenceStart) return " ";
    // Mid-sentence: a real stop after the filler belongs to the words before it
    // ("wide, hmm?" -> "wide?"); a hesitation ellipsis does not.
    const kept = end.replace(/\u2026|\.{2,}/gu, "");
    return kept ? kept + " " : " ";
  });
  if (stripped === text) return text;

  const out = stripped
    .replace(/[^\S\r\n]{2,}/g, " ")
    .replace(/[^\S\r\n]+([,.;:!?…])/g, "$1")
    .trim();

  if (!out) return out;

  // Re-capitalise a word that now opens the text (only when a filler was
  // removed from the front) or follows a sentence stop.
  const capitalised = out.replace(
    /([.!?\u2026]\s+)(\p{Ll})/gu,
    (m, sep, c) => sep + c.toUpperCase()
  );
  return removedAtStart ? capitalised.replace(/^(\p{Ll})/u, (c) => c.toUpperCase()) : capitalised;
}
