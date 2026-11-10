/**
 * Drops the tiny wrong-language rows streaming models invent from noise and
 * crosstalk (어., Да., うん。), 83% of which are four characters or fewer.
 */
const MAX_FRAGMENT_CHARS = 4;

// Latin is always allowed: brand names and "OK" turn up in every language.
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
const scriptPattern = (scripts) =>
  new RegExp(`[${scripts.map((s) => `\\p{Script_Extensions=${s}}`).join("")}]`, "u");

// Null when any language's scripts are unknown, since then nothing can be called wrong.
function expectedScripts(languages) {
  const scripts = ["Latin"];
  for (const language of languages) {
    const base = String(language).toLowerCase().split("-")[0];
    if (OTHER_SCRIPTS[base]) scripts.push(...OTHER_SCRIPTS[base]);
    else if (!LATIN_LANGUAGES.has(base)) return null;
  }
  return scripts;
}

function isWrongScriptFragment(text, languages) {
  const trimmed = String(text ?? "").trim();
  if (!languages.length || [...trimmed].length > MAX_FRAGMENT_CHARS) return false;
  const scripts = expectedScripts(languages);
  if (!scripts) return false;
  const expected = scriptPattern(scripts);
  return (trimmed.match(LETTER) ?? []).some((letter) => !expected.test(letter));
}

// The meeting's language when one is set; for "auto", the languages the user speaks.
function fragmentFilterLanguages(options) {
  const language = options?.language;
  if (language && language !== "auto") return [language];
  return Array.isArray(options?.spokenLanguages) ? options.spokenLanguages : [];
}

module.exports = { fragmentFilterLanguages, isWrongScriptFragment };
