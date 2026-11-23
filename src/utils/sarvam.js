// REST language codes differ from Sarvam's realtime API (notably Odia and auto).
const REST_LANGUAGES = new Set(
  "as bn brx doi en gu hi kn kok ks mai ml mni mr ne od pa sa sat sd ta te ur".split(" ")
);

export const SARVAM_MODES = /** @type {const} */ ([
  "codemix",
  "transcribe",
  "verbatim",
  "translate",
  "translit",
]);

/** @typedef {(typeof SARVAM_MODES)[number]} SarvamMode */

/**
 * @param {unknown} mode
 * @returns {SarvamMode}
 */
export function resolveSarvamMode(mode) {
  return SARVAM_MODES.find((candidate) => candidate === mode) ?? "codemix";
}

/**
 * Translate produces English independently of the recognition language hint.
 * @param {string | null | undefined} provider
 * @param {unknown} mode
 * @param {string} [inputLanguage]
 * @returns {string | undefined}
 */
export function sarvamTranscriptLanguage(provider, mode, inputLanguage) {
  if (provider !== "sarvam") return undefined;
  return mode === "translate" ? "en" : resolveSarvamInputLanguage(inputLanguage);
}

export function sarvamLanguage(language) {
  const base = language?.toLowerCase().split("-")[0];
  const code = base === "or" ? "od" : base;
  return REST_LANGUAGES.has(code) ? code + "-IN" : undefined;
}

/**
 * Keep supported regional preferences for cleanup and script conversion.
 * Unrecognized hints leave the output language unknown.
 * @param {string | null | undefined} language
 * @returns {string}
 */
export function resolveSarvamInputLanguage(language) {
  return sarvamLanguage(language) ? language : "auto";
}

export function sarvamKeyterms(words = []) {
  const terms = new Set();
  for (const word of words) {
    const term = word.trim();
    if (term && [...term].length <= 64) terms.add(term);
    if (terms.size === 50) break;
  }
  return [...terms];
}
