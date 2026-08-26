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

// Unspaced scripts (Han, kana) and CJK punctuation (Symbols and Punctuation,
// Fullwidth/Halfwidth Forms, Vertical Forms, Compatibility Forms): a trailing
// ASCII space after "你好" or "です。" violates East Asian typography and
// accumulates as "你好 世界" gaps across consecutive dictations. Hangul is
// excluded on purpose — Korean separates words with spaces.
const ENDS_WITH_CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uff65\ufe10-\ufe1f\ufe30-\ufe4f]$/u;

function applyAppend(text) {
  if (/\s$/.test(text)) return text;
  if (ENDS_WITH_CJK.test(text)) return text;
  return text + " ";
}

module.exports = { applySmartSpacing };
