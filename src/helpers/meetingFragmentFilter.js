/**
 * Drops the tiny wrong-language rows transcription models invent from noise and
 * crosstalk (어., Да., うん。), 83% of which are four characters or fewer.
 */
const MAX_FRAGMENT_CHARS = 4;

// Latin and script-neutral letters (µ) are always allowed: brand names, "OK" and "5µs" go anywhere.
const LATIN_LANGUAGES = new Set(
  "af az bs ca cs cy da de en es et fi fr gl hr hu id is it lt lv mi ms mt nl no pl pt ro sk sl sv sw tl tr vi".split(
    " "
  )
);
const OTHER_SCRIPTS = {
  ar: ["Arabic"],
  fa: ["Arabic"],
  ur: ["Arabic"],
  be: ["Cyrillic"],
  bg: ["Cyrillic"],
  kk: ["Cyrillic"],
  mk: ["Cyrillic"],
  ru: ["Cyrillic"],
  sr: ["Cyrillic"],
  uk: ["Cyrillic"],
  el: ["Greek"],
  he: ["Hebrew"],
  hi: ["Devanagari"],
  mr: ["Devanagari"],
  ne: ["Devanagari"],
  hy: ["Armenian"],
  kn: ["Kannada"],
  ta: ["Tamil"],
  th: ["Thai"],
  ja: ["Han", "Hiragana", "Katakana"],
  ko: ["Hangul", "Han"],
  zh: ["Han"],
};

const LETTER = /\p{L}/gu;

// Null when any language's scripts are unknown, since then nothing can be called wrong.
function expectedScriptPattern(languages) {
  const scripts = ["Latin", "Common"];
  for (const language of languages) {
    const base = String(language).toLowerCase().split("-")[0];
    if (OTHER_SCRIPTS[base]) scripts.push(...OTHER_SCRIPTS[base]);
    else if (!LATIN_LANGUAGES.has(base)) return null;
  }
  return new RegExp(`[${scripts.map((s) => `\\p{Script_Extensions=${s}}`).join("")}]`, "u");
}

function isWrongScriptFragment(text, languages) {
  const trimmed = text.trim();
  if (!languages.length || [...trimmed].length > MAX_FRAGMENT_CHARS) return false;
  const expected = expectedScriptPattern(languages);
  if (!expected) return false;
  return (trimmed.match(LETTER) ?? []).some((letter) => !expected.test(letter));
}

// The meeting's language when one is set; for "auto", the languages the user speaks.
function fragmentFilterLanguages(options) {
  const language = options?.language;
  if (language && language !== "auto") return [language];
  return Array.isArray(options?.spokenLanguages) ? options.spokenLanguages : [];
}

module.exports = { fragmentFilterLanguages, isWrongScriptFragment };
