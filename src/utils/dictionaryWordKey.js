/**
 * Canonical identity shared by the renderer and main-process dictionary fallbacks.
 * @param {string} word
 * @returns {string}
 */
export function dictionaryWordKey(word) {
  return word.normalize("NFC").trim().toLowerCase();
}
