// Quote marks models wrap generated titles in despite the prompt: ASCII,
// typographic (curly, German low-9), guillemets, and CJK title brackets.
// prettier-ignore
const WRAPPING_QUOTES = new Set([
  '"', "'", "“", "”", "‘", "’", "„", "‚", "«", "»", "「", "」", "『", "』", "《", "》",
]);

// Apostrophe-shaped marks are never stripped one-sided: at a single end they
// are usually part of the word (Workin’, ’Tis the Season), not a wrapper.
const APOSTROPHES = new Set(["'", "‘", "’"]);

// The marks that close each opening quote. „ and ‚ close with either curly
// form, and » opens Danish »text« as well as Swedish »text».
const CLOSERS: Record<string, string[]> = {
  '"': ['"'],
  "'": ["'"],
  "“": ["”"],
  "”": ["”"],
  "‘": ["’"],
  "’": ["’"],
  "„": ["“", "”"],
  "‚": ["‘", "’"],
  "«": ["»"],
  "»": ["«", "»"],
  "「": ["」"],
  "『": ["』"],
  "《": ["》"],
};

const isLetter = (char: string | undefined): boolean => !!char && /\p{L}/u.test(char);

// True when the two ends of `text` belong to different quoted phrases
// (“Dune” vs “Arrival”): the opening quote is closed before the end and a new
// one of the same kind opens after it. An apostrophe between two letters
// (Don't) closes nothing, and a closing mark with no new quote after it
// (‘Workin’ late’) still leaves the ends as one wrapper.
const quotesSeparatePhrases = (text: string): boolean => {
  const open = text[0];
  const closers = CLOSERS[open];
  if (!closers) return false;
  let depth = 0;
  for (let i = 1; i < text.length - 1; i += 1) {
    const char = text[i];
    if (closers.includes(char)) {
      if (APOSTROPHES.has(char) && isLetter(text[i - 1]) && isLetter(text[i + 1])) continue;
      if (depth === 0) return text.slice(i + 1, -1).includes(open);
      depth -= 1;
    } else if (char === open) {
      depth += 1;
    }
  }
  return false;
};

const hasQuoteBesides = (text: string, index: number): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    if (i !== index && WRAPPING_QUOTES.has(text[i])) return true;
  }
  return false;
};

// Peel wrapping quotes the model added despite the prompt. Only matched
// wrappers (a quote at BOTH ends) are peeled, so a title that merely contains
// a quoted phrase at one end — Feedback on “Project X” — stays intact.
// So do two quoted phrases at the two ends: “Dune” vs “Arrival”.
export function sanitizeGeneratedTitle(raw: string): string {
  let cleaned = raw.trim();
  while (
    cleaned.length >= 2 &&
    WRAPPING_QUOTES.has(cleaned[0]) &&
    WRAPPING_QUOTES.has(cleaned[cleaned.length - 1]) &&
    !quotesSeparatePhrases(cleaned)
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
