// Batch requests with more than 100 terms incur a 20-second minimum charge.
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_CHARS = 50;
const MAX_KEYTERM_WORDS = 5;
const FORBIDDEN_KEYTERM_CHARS = /[<>{}[\]\\]/;

export function sanitizeKeyterms(keyterms, maxTerms = MAX_KEYTERMS, maxChars = MAX_KEYTERM_CHARS) {
  if (!Array.isArray(keyterms)) return [];
  const seen = new Set();
  const terms = [];
  for (const raw of keyterms) {
    if (typeof raw !== "string") continue;
    const term = raw.trim().replace(/\s+/g, " ");
    if (!term || Array.from(term).length > maxChars) continue;
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
