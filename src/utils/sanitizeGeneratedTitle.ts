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

// Letters and digits of scripts that separate words with spaces.
const isSpacedWordCharacter = (char: string | undefined): boolean =>
  !!char && /[\p{N}\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}]/u.test(char);

const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });

// Preserve separate phrases only when the final mark closes a later phrase.
// A later opener alone can also belong inside a genuine outer wrapper.
const quotesSeparatePhrases = (text: string): boolean => {
  const open = text[0];
  const closers = CLOSERS[open];
  if (!closers) return false;
  const symmetric = closers.includes(open);
  const characters: string[] = [];
  const literalApostrophes: boolean[] = [];
  // Unicode word boundaries distinguish Don't from unspaced ‘计划’与‘预算’.
  for (const { segment, isWordLike } of wordSegmenter.segment(text)) {
    for (const char of segment) {
      characters.push(char);
      literalApostrophes.push(!!isWordLike && APOSTROPHES.has(char));
    }
  }
  // A straight apostrophe between two letters or digits of a spaced script
  // (Q4's) is part of the word even where the segmenter splits it off.
  if (open === "'") {
    for (let index = 1; index < characters.length - 1; index += 1) {
      if (
        characters[index] === "'" &&
        isSpacedWordCharacter(characters[index - 1]) &&
        isSpacedWordCharacter(characters[index + 1])
      ) {
        literalApostrophes[index] = true;
      }
    }
  }
  // For paired marks, only the closers beyond the openers can be apostrophes:
  // ‘Don’t stop’ has one spare ’, but each ’ in ‘نعم’و‘لا’ closes a phrase.
  if (!symmetric) {
    let openers = 0;
    let spare = -1;
    for (const char of characters) {
      if (char === open) openers += 1;
      else if (closers.includes(char)) spare += 1;
    }
    spare -= openers - 1;
    for (let index = 0; index < characters.length; index += 1) {
      if (!literalApostrophes[index]) continue;
      if (spare > 0) spare -= 1;
      else literalApostrophes[index] = false;
    }
  }

  // Index runs once per peel so checking each quote never rescans its run.
  const runStarts: number[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    runStarts[index] =
      index > 0 && characters[index] === characters[index - 1] ? runStarts[index - 1] : index;
  }
  const nextNonQuote: number[] = new Array(characters.length + 1);
  const nextContent: number[] = new Array(characters.length + 1);
  nextNonQuote[characters.length] = characters.length;
  nextContent[characters.length] = characters.length;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const quote = WRAPPING_QUOTES.has(characters[index]);
    nextNonQuote[index] = quote ? nextNonQuote[index + 1] : index;
    nextContent[index] = quote || /\s/u.test(characters[index]) ? nextContent[index + 1] : index;
  }

  const opensQuote = (index: number, nested: boolean): boolean => {
    const nextIndex = nested ? nextNonQuote[index + 1] : nextContent[index + 1];
    if (nextIndex >= characters.length || /\s/u.test(characters[nextIndex])) return false;
    const previous = characters[runStarts[index] - 1];
    // In space-separated scripts a straight mark right after a letter or digit
    // closes something (6", 8", James') rather than opening a new phrase.
    // Unspaced scripts open phrases mid-run: "設計"と"実装", "نعم"و"لا".
    if (symmetric && isSpacedWordCharacter(previous)) return false;
    if (!nested) {
      return (
        !symmetric ||
        !APOSTROPHES.has(open) ||
        !isWordCharacter(previous) ||
        !/\s/u.test(characters[index + 1] ?? "")
      );
    }
    // A nested phrase starts with its text, so a padded closer followed by a
    // separator ("Q3 "/"Q4") is not mistaken for one.
    if (!isWordCharacter(characters[nextIndex]) && !/[\p{Ps}\p{Pi}]/u.test(characters[nextIndex]))
      return false;
    return !previous || /[\s\p{Ps}\p{Pi}]/u.test(previous) || WRAPPING_QUOTES.has(previous);
  };
  let depth = 1;
  let phrases = 0;
  let finalQuoteClosed = false;
  for (let index = 1; index < characters.length; index += 1) {
    if (literalApostrophes[index]) continue;
    const char = characters[index];
    if (depth === 0) {
      if (char === open && opensQuote(index, false)) depth = 1;
    } else if (char === open && (!symmetric || opensQuote(index, true))) {
      depth += 1;
    } else if (closers.includes(char)) {
      depth -= 1;
      if (depth === 0) {
        phrases += 1;
        finalQuoteClosed = index === characters.length - 1;
      }
    }
  }
  return phrases > 1 && finalQuoteClosed;
};

// Titles are capped at 99 characters, so a reply this long cannot hold one even
// after its wrappers are peeled. Rejecting it up front also bounds the work
// the peel loop does on a runaway reply of stacked quotes.
const MAX_RAW_LENGTH = 300;

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
  if (cleaned.length > MAX_RAW_LENGTH) return "";
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
