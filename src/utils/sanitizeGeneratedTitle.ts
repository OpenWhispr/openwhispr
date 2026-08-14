const WRAPPING_QUOTES = new Set(['"', "'", "\u201c", "\u201d", "\u2018", "\u2019", "«", "»"]);

// Models often wrap the title in ASCII or typographic quotes despite the prompt.
// Peel those wrappers from both ends; leave inner apostrophes (Don't) intact.
export function sanitizeGeneratedTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let cleaned = raw.trim();
  while (
    cleaned.length > 0 &&
    (WRAPPING_QUOTES.has(cleaned[0]) || WRAPPING_QUOTES.has(cleaned[cleaned.length - 1]))
  ) {
    if (WRAPPING_QUOTES.has(cleaned[0])) cleaned = cleaned.slice(1).trim();
    if (cleaned.length > 0 && WRAPPING_QUOTES.has(cleaned[cleaned.length - 1])) {
      cleaned = cleaned.slice(0, -1).trim();
    }
  }
  return cleaned.length > 0 && cleaned.length < 100 ? cleaned : "";
}
