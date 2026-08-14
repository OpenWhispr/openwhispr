// Quote marks models wrap generated titles in despite the prompt: ASCII,
// typographic (curly, German low-9), guillemets, and CJK title brackets.
// prettier-ignore
const WRAPPING_QUOTES = new Set([
  '"', "'", "“", "”", "‘", "’", "„", "‚", "«", "»", "「", "」", "『", "』", "《", "》",
]);

// Apostrophe-shaped marks are never stripped one-sided: at a single end they
// are usually part of the word (Workin’, ’Tis the Season), not a wrapper.
const APOSTROPHES = new Set(["'", "‘", "’"]);

const hasQuoteBesides = (text: string, index: number): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    if (i !== index && WRAPPING_QUOTES.has(text[i])) return true;
  }
  return false;
};

// Peel wrapping quotes the model added despite the prompt. Only matched
// wrappers (a quote at BOTH ends) are peeled, so a title that merely contains
// a quoted phrase at one end — Feedback on “Project X” — stays intact.
export function sanitizeGeneratedTitle(raw: string): string {
  let cleaned = raw.trim();
  while (
    cleaned.length >= 2 &&
    WRAPPING_QUOTES.has(cleaned[0]) &&
    WRAPPING_QUOTES.has(cleaned[cleaned.length - 1])
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // An unterminated wrapper ("Weekly standup) leaves a quote at exactly one
  // end with no counterpart anywhere else in the string; strip it.
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (WRAPPING_QUOTES.has(first) && !APOSTROPHES.has(first) && !hasQuoteBesides(cleaned, 0)) {
      cleaned = cleaned.slice(1).trim();
    } else if (
      WRAPPING_QUOTES.has(last) &&
      !APOSTROPHES.has(last) &&
      !hasQuoteBesides(cleaned, cleaned.length - 1)
    ) {
      cleaned = cleaned.slice(0, -1).trim();
    }
  }

  if (cleaned.length === 1 && WRAPPING_QUOTES.has(cleaned)) return "";
  return cleaned.length > 0 && cleaned.length < 100 ? cleaned : "";
}
