// Text extraction for Gemini generateContent API responses. `content.parts`
// is an array that may contain multiple text parts or lead with thought
// blocks (Gemini thinking), so `parts[0].text` is not safe.

/**
 * Extract user-facing text from a Gemini generateContent response candidate.
 * Concatenates all text parts while ignoring thought parts (from Gemini thinking).
 * Returns trimmed text, or null if no valid text parts exist.
 *
 * @param {object} [candidate]
 * @returns {string | null}
 */
export function extractGeminiText(candidate) {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const textParts = parts
    .filter((part) => !part?.thought && typeof part?.text === "string" && part.text.length > 0)
    .map((part) => part.text);
  if (textParts.length === 0) return null;
  return textParts.join("").trim();
}
