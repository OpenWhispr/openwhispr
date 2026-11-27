// ElevenLabs rejects the whole request (400) for a single keyterm outside its
// documented limits, so terms that break them are dropped rather than sent.
// It takes 1000 keyterms, but bills at least 20 seconds for a request with more
// than 100, which would multiply the cost of a short dictation.
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_CHARS = 50;
const MAX_KEYTERM_WORDS = 5;
// \s misses U+001C to U+001F and U+0085, which ElevenLabs reads as whitespace
// as well: it counts them as spaces, and a term of only them as empty.
const KEYTERM_WHITESPACE = /[\s\u001c-\u001f\u0085]+/g;
// ElevenLabs refuses these control characters too. U+0009 to U+000D and the
// ones after U+001B are whitespace, collapsed before the test.
const FORBIDDEN_KEYTERM_CHARS = /[<>{}[\]\\\u0000-\u0008\u000e-\u001b]/;

export function sanitizeElevenLabsKeyterms(
  keyterms,
  maxTerms = MAX_KEYTERMS,
  maxChars = MAX_KEYTERM_CHARS
) {
  if (!Array.isArray(keyterms)) return [];
  const seen = new Set();
  const terms = [];
  for (const raw of keyterms) {
    if (typeof raw !== "string") continue;
    const term = raw.replace(KEYTERM_WHITESPACE, " ").trim();
    if (!term || [...term].length > maxChars) continue;
    if (term.split(" ").length > MAX_KEYTERM_WORDS) continue;
    if (FORBIDDEN_KEYTERM_CHARS.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === maxTerms) break;
  }
  return terms;
}
