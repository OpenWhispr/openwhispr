// Word-boundary occurrence counting for dictionary usage ranking.
// Terms are user input: everything is regex-escaped, so patterns stay literal
// and cannot backtrack pathologically.

// Dictations are a few KB; the cap only guards against pathological payloads.
const MAX_USAGE_SCAN_CHARS = 20000;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Boundary = adjacent char is not a letter/digit/underscore, so "view" never
// matches inside "views" but "C++" still matches next to punctuation.
function buildTermPattern(term) {
  const parts = term.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (parts.length === 0) return null;
  const body = parts.join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu");
}

/**
 * Count word-boundary, case-insensitive occurrences of each term in `text`.
 * Longest terms match first and claim their span, so a term that is a subset
 * of another matched term is not double-counted.
 *
 * @param {string} text finalized transcript to scan
 * @param {string[]} terms dictionary words/phrases
 * @returns {Map<string, number>} lowercased term -> occurrence count (>0 only)
 */
function countDictionaryTermOccurrences(text, terms) {
  const counts = new Map();
  if (typeof text !== "string" || !text) return counts;
  const scanText = text.length > MAX_USAGE_SCAN_CHARS ? text.slice(0, MAX_USAGE_SCAN_CHARS) : text;

  const seen = new Set();
  const cleaned = [];
  for (const raw of Array.isArray(terms) ? terms : []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    cleaned.push({ lower, term: trimmed });
  }
  if (cleaned.length === 0) return counts;

  // Longest first, then alphabetical for a deterministic claim order.
  cleaned.sort((a, b) => b.term.length - a.term.length || (a.lower < b.lower ? -1 : 1));

  const claimed = new Uint8Array(scanText.length);
  const spanIsFree = (start, end) => {
    for (let i = start; i < end; i += 1) {
      if (claimed[i]) return false;
    }
    return true;
  };

  for (const { lower, term } of cleaned) {
    const pattern = buildTermPattern(term);
    if (!pattern) continue;
    let found = 0;
    let match;
    while ((match = pattern.exec(scanText)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (spanIsFree(start, end)) {
        claimed.fill(1, start, end);
        found += 1;
      }
      if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
    }
    if (found > 0) counts.set(lower, found);
  }
  return counts;
}

module.exports = { countDictionaryTermOccurrences, MAX_USAGE_SCAN_CHARS };
