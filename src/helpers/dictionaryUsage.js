// Word-boundary occurrence counting for dictionary usage ranking.
// Terms are user input: everything is regex-escaped, so the pattern stays
// literal and cannot backtrack pathologically.

// Dictations are a few KB; the cap only guards against pathological payloads.
const MAX_USAGE_SCAN_CHARS = 20000;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonical lookup key for a dictionary term: NFC, lowercased, inner
 * whitespace collapsed. Must match how counting keys its results.
 *
 * @param {string} term
 * @returns {string}
 */
function canonicalTermKey(term) {
  return term.trim().normalize("NFC").toLowerCase().replace(/\s+/g, " ");
}

/**
 * Count word-boundary, case-insensitive occurrences of each term in `text`.
 * Single alternation pass with longest alternatives first: at any position
 * the longest term wins, so a term contained in another match is not
 * double-counted. Both sides are NFC-normalized so decomposed transcript
 * accents still match composed dictionary terms.
 *
 * @param {string} text finalized transcript to scan
 * @param {string[]} terms dictionary words/phrases
 * @returns {Map<string, number>} canonical term key -> occurrence count (>0 only)
 */
function countDictionaryTermOccurrences(text, terms) {
  const counts = new Map();
  if (typeof text !== "string" || !text) return counts;
  const normalized = text.normalize("NFC");
  const scanText =
    normalized.length > MAX_USAGE_SCAN_CHARS
      ? normalized.slice(0, MAX_USAGE_SCAN_CHARS)
      : normalized;

  const byKey = new Map();
  for (const raw of Array.isArray(terms) ? terms : []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().normalize("NFC");
    if (!trimmed) continue;
    const key = canonicalTermKey(trimmed);
    if (!byKey.has(key)) byKey.set(key, trimmed);
  }
  if (byKey.size === 0) return counts;

  const alternatives = [...byKey.values()]
    .sort((a, b) => b.length - a.length || (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    .map((term) => term.split(/\s+/).filter(Boolean).map(escapeRegExp).join("\\s+"));

  // Boundary = adjacent char is not a letter/digit/underscore, so "view"
  // never matches inside "views" but "C++" still matches next to punctuation.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
    "giu"
  );

  let match;
  while ((match = pattern.exec(scanText)) !== null) {
    const key = canonicalTermKey(match[0]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
  }
  return counts;
}

module.exports = { countDictionaryTermOccurrences, canonicalTermKey, MAX_USAGE_SCAN_CHARS };
