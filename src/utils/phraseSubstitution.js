/**
 * @typedef {import("../types/phrases").CustomPhrase} CustomPhrase
 */

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(value) {
  return value.replace(REGEX_META, "\\$&");
}

// A "word-ish" character that should anchor the boundary around a trigger.
// We use Unicode-aware \p{L}/\p{N} so the boundary works for non-ASCII triggers.
const BOUNDARY_LEFT = "(^|[^\\p{L}\\p{N}_])";
const BOUNDARY_RIGHT = "(?![\\p{L}\\p{N}_])";

/**
 * @param {string} text
 * @param {CustomPhrase[]} phrases
 * @returns {string}
 */
export function applyPhrases(text, phrases) {
  if (!text || !phrases?.length) return text;

  // Longer triggers first so "message template one" beats "message".
  const ordered = phrases
    .filter((p) => p && typeof p.trigger === "string" && p.trigger.trim().length > 0)
    .slice()
    .sort((a, b) => b.trigger.trim().length - a.trigger.trim().length);

  let result = text;
  for (const phrase of ordered) {
    const trigger = phrase.trigger.trim();
    const snippet = phrase.snippet ?? "";
    const pattern = new RegExp(
      `${BOUNDARY_LEFT}${escapeRegex(trigger)}${BOUNDARY_RIGHT}`,
      "giu"
    );
    result = result.replace(pattern, (_match, leading) => `${leading}${snippet}`);
  }
  return result;
}
