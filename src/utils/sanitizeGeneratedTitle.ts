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

const isWordCharacter = (char: string | undefined): boolean =>
  !!char && /[\p{L}\p{M}\p{N}]/u.test(char);

// True when the two ends of `text` belong to different quoted phrases
// (“Dune” vs “Arrival”): the opening quote is closed before the end and a new
// one of the same kind opens after it. An apostrophe within a word
// (Don't) closes nothing, and a closing mark with no new quote after it
// (‘Workin’ late’) still leaves the ends as one wrapper.
const quotesSeparatePhrases = (text: string): boolean => {
  const characters = Array.from(text);
  const open = characters[0];
  const closers = CLOSERS[open];
  if (!closers) return false;
  const symmetric = closers.includes(open);
  const opensPhrase = (index: number, afterClosingQuote = false): boolean => {
    if (characters[index] !== open) return false;
    let previousIndex = index - 1;
    // Consecutive quotes inherit the run's context: stacked openers and
    // stacked closers must not be mistaken for separate phrases.
    while (characters[previousIndex] === open) previousIndex -= 1;
    if (symmetric && isWordCharacter(characters[previousIndex])) return false;
    let nextIndex = index + 1;
    while (
      nextIndex < characters.length &&
      (WRAPPING_QUOTES.has(characters[nextIndex]) ||
        (afterClosingQuote && /\s/u.test(characters[nextIndex])))
    ) {
      nextIndex += 1;
    }
    // Before the first phrase closes, punctuation on both sides marks a
    // closer ("Dune!"/"Arrival?"), not the start of a nested phrase.
    return (
      nextIndex < characters.length &&
      !/\s/u.test(characters[nextIndex]) &&
      (!symmetric ||
        afterClosingQuote ||
        !/[\p{P}\p{S}]/u.test(characters[previousIndex] ?? "") ||
        !/\p{P}/u.test(characters[nextIndex]))
    );
  };
  let depth = 0;
  for (let i = 1; i < characters.length - 1; i += 1) {
    const char = characters[i];
    if (
      APOSTROPHES.has(char) &&
      isWordCharacter(characters[i - 1]) &&
      isWordCharacter(characters[i + 1])
    ) {
      continue;
    }
    if (char === open && (!symmetric || opensPhrase(i))) {
      depth += 1;
    } else if (closers.includes(char)) {
      if (depth === 0) {
        for (let next = i + 1; next < characters.length - 1; next += 1) {
          if (opensPhrase(next, true)) return true;
        }
        return false;
      }
      depth -= 1;
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
  if (!Array.from(cleaned).some((char) => !WRAPPING_QUOTES.has(char) && /\S/u.test(char)))
    return "";
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

  return cleaned.length > 0 && cleaned.length < 100 ? cleaned : "";
}
