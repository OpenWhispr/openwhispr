// REST language codes differ from Sarvam's realtime API (notably Odia and auto).
const REST_LANGUAGES = new Set(
  "as bn brx doi en gu hi kn kok ks mai ml mni mr ne od pa sa sat sd ta te ur".split(" ")
);

// Writes English words, dictionary terms included, in the speaker's native script.
// Preference varies ("codemix" keeps them in Latin, "translit" romanizes everything);
// this is the safe default until users can choose.
export const SARVAM_MODE = "transcribe";

export function sarvamLanguage(language) {
  const base = language?.toLowerCase().split("-")[0];
  const code = base === "or" ? "od" : base;
  return REST_LANGUAGES.has(code) ? code + "-IN" : undefined;
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
