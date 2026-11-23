// Paste-time spacing: append a trailing space so the next dictation's paste
// doesn't run into this one. Kept pure so the rules stay unit-testable.

// Unspaced scripts (Han, kana) and CJK punctuation (Symbols and Punctuation,
// Fullwidth/Halfwidth Forms, Vertical Forms, Compatibility Forms): a trailing
// ASCII space after "你好" or "です。" violates East Asian typography and
// accumulates as "你好 世界" gaps across consecutive dictations. Hangul is
// excluded on purpose — Korean separates words with spaces.
const ENDS_WITH_CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uff65\ufe10-\ufe1f\ufe30-\ufe4f]$/u;
// Chinese text ends in General Punctuation quotes, ellipsis and dashes
// (“ ” ‘ ’ …… ——), which are shared with Latin text, so they count as CJK
// only after a CJK character: "He said “hi”" keeps its space.
const ENDS_WITH_CJK_THEN_PUNCTUATION =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uff65][\u2014\u2018\u2019\u201c\u201d\u2026]+$/u;

function applySmartSpacing(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (/\s$/.test(text)) return text;
  if (ENDS_WITH_CJK.test(text) || ENDS_WITH_CJK_THEN_PUNCTUATION.test(text)) return text;
  return text + " ";
}

module.exports = { applySmartSpacing };
