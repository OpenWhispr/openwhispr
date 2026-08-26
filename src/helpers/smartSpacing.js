// Paste-time spacing: append a trailing space so the next dictation's paste
// doesn't run into this one. Kept pure so the rules stay unit-testable.

// Unspaced scripts (Han, kana) and CJK punctuation (Symbols and Punctuation,
// Fullwidth/Halfwidth Forms, Vertical Forms, Compatibility Forms): a trailing
// ASCII space after "你好" or "です。" violates East Asian typography and
// accumulates as "你好 世界" gaps across consecutive dictations. Hangul is
// excluded on purpose — Korean separates words with spaces.
const ENDS_WITH_CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uff65\ufe10-\ufe1f\ufe30-\ufe4f]$/u;

function applySmartSpacing(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (/\s$/.test(text)) return text;
  if (ENDS_WITH_CJK.test(text)) return text;
  return text + " ";
}

module.exports = { applySmartSpacing };
