// Deterministic post-transcription corrections ("wheels" -> "views"): matching is
// case-insensitive and whole-word, mirroring the expandSnippets matcher strategy.
const MAX_RULES = 1000;
const MAX_FROM_LENGTH = 120;
const MAX_TO_LENGTH = 240;

// Same separator classes expandSnippets uses, so both features agree on word edges.
const SEPARATOR = "[\\s\\p{P}\\p{S}]";

function collapseWhitespace(value) {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

/**
 * Sanitize raw rule objects into a deterministic list: trimmed, NFC-normalized,
 * bounded, deduped case-insensitively on `from` (first occurrence wins), and
 * with exact self-maps dropped. Case-only pairs ("github" -> "GitHub") survive.
 */
export function normalizeReplacementRules(rules) {
  if (!Array.isArray(rules)) return [];
  const seen = new Set();
  const normalized = [];
  for (const rule of rules) {
    if (normalized.length >= MAX_RULES) break;
    if (!rule || typeof rule.from !== "string" || typeof rule.to !== "string") continue;
    const from = collapseWhitespace(rule.from);
    const to = collapseWhitespace(rule.to);
    if (!from || !to || from === to) continue;
    if (from.length > MAX_FROM_LENGTH || to.length > MAX_TO_LENGTH) continue;
    const key = from.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ from, to });
  }
  return normalized;
}

// A lowercase `to` adapts to the matched casing (espanso-style propagation), so a
// "views" rule fixes "Wheels" at sentence start without screaming VIEWS. Any
// uppercase in `to` means the user chose the casing — keep it verbatim.
function adaptReplacementCase(replacement, matched) {
  if (/\p{Lu}/u.test(replacement)) return replacement;
  if (
    matched.length > 1 &&
    matched === matched.toUpperCase() &&
    matched !== matched.toLowerCase()
  ) {
    return replacement.toUpperCase();
  }
  const first = matched.charAt(0);
  if (first !== first.toLowerCase() && first === first.toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function buildMatcher(rules) {
  const normalized = normalizeReplacementRules(rules);
  if (normalized.length === 0) return null;

  const replacements = new Map();
  for (const { from, to } of normalized) {
    replacements.set(from.toLowerCase(), to);
  }

  // Longest-first so a "git hub pages" rule wins over a shorter "git hub" one;
  // codepoint tiebreak keeps the alternation order deterministic.
  const escaped = [...replacements.keys()]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((from) => from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(?<=^|${SEPARATOR})(?:${escaped.join("|")})(?=$|${SEPARATOR})`, "giu");
  return { regex, replacements };
}

let cachedRules = null;
let cachedMatcher = null;

/**
 * Apply every rule in a single pass: one rule's output is never re-scanned by
 * another, so chains don't cascade and cyclic pairs (a->b, b->a) just swap.
 * The matcher is memoized against the rules array reference (the settings
 * store replaces the array on every change).
 */
export function applyTextReplacements(text, rules) {
  if (!text || typeof text !== "string" || !Array.isArray(rules) || rules.length === 0) {
    return text;
  }
  if (rules !== cachedRules) {
    cachedRules = rules;
    cachedMatcher = buildMatcher(rules);
  }
  if (!cachedMatcher) return text;
  const { regex, replacements } = cachedMatcher;
  // NFC so decomposed transcript characters recombine before literal matching.
  return text.normalize("NFC").replace(regex, (match) => {
    const to = replacements.get(match.toLowerCase());
    return to === undefined ? match : adaptReplacementCase(to, match);
  });
}

/**
 * The seam audioManager calls at every post-STT funnel: reads the rule list off
 * the settings snapshot and no-ops at zero cost when the user has none.
 */
export function applyTranscriptReplacements(text, settings) {
  const rules = settings?.dictionaryReplacements;
  if (!Array.isArray(rules) || rules.length === 0) return text;
  return applyTextReplacements(text, rules);
}
