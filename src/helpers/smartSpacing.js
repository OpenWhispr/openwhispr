// Pure spacing rules applied between previously-typed text and a paste.
// "prepend" mode needs the char before the cursor (read via Accessibility on
// macOS); "append" mode is the platform-agnostic fallback.

const OPENING_CHARS = new Set([" ", "\t", "\n", "\r", "(", "[", "{", "<", '"', "'", "`", "“", "‘"]);
const LEADING_PUNCTUATION = new Set([",", ".", "!", "?", ";", ":", ")", "]", "}", "%", "”", "’"]);

function applySmartSpacing({ text, mode, precedingChar }) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (mode === "prepend") return applyPrepend(text, precedingChar);
  if (mode === "append") return applyAppend(text);
  return text;
}

function applyPrepend(text, precedingChar) {
  if (precedingChar == null || precedingChar === "") return text;
  if (/^\s/.test(text)) return text;
  if (OPENING_CHARS.has(precedingChar)) return text;
  // Don't separate prior text from closing punctuation: "Hello" + ", world".
  if (LEADING_PUNCTUATION.has(text[0])) return text;
  return " " + text;
}

function applyAppend(text) {
  if (/\s$/.test(text)) return text;
  return text + " ";
}

// Characters that end a sentence; a dictation pasted after one keeps (or
// gains) its leading capital. A line break counts even without punctuation.
const SENTENCE_ENDERS = new Set([".", "!", "?", "…", ":", "\n", "\r"]);
// Closers that may trail the ender itself: he said "stop."
const TRAILING_CLOSERS = /["'”’)\]}]+$/;

// Match Wispr-Flow-style continuation: adjust the first letter of a paste to
// fit the text already before the cursor. Mid-sentence continuations lose the
// STT engine's automatic leading capital; fresh sentences gain one.
// `precedingTail` is the text just before the cursor ("" = start of field);
// null/undefined means the context is unknown and the text is left alone.
function applyContinuationCasing(text, precedingTail) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (precedingTail == null) return text;

  const raw = String(precedingTail);
  const trimmed = raw.replace(/\s+$/, "").replace(TRAILING_CLOSERS, "");
  const atSentenceStart =
    trimmed.length === 0 ||
    SENTENCE_ENDERS.has(trimmed[trimmed.length - 1]) ||
    // A line break between the last word and the cursor starts a new line
    // even when the previous line had no closing punctuation.
    /[\n\r][ \t]*$/.test(raw);

  const first = text[0];
  if (atSentenceStart) {
    const upper = first.toUpperCase();
    return upper === first ? text : upper + text.slice(1);
  }

  const lower = first.toLowerCase();
  if (lower === first) return text;
  // Spare the pronoun "I" and its contractions, and acronyms (second letter
  // also uppercase). Proper nouns can't be told apart without a dictionary;
  // losing their capital mid-sentence is the lesser error.
  const word = text.match(/^[A-Za-z'’]+/)?.[0] ?? "";
  if (word === "I" || /^I['’]/.test(word)) return text;
  if (text.length > 1 && text[1] !== text[1].toLowerCase()) return text;
  return lower + text.slice(1);
}

module.exports = { applySmartSpacing, applyContinuationCasing };
