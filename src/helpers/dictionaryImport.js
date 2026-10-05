/**
 * Split a bulk-import paste into dictionary words.
 * Accepts comma-separated values, one word per line, or a mix of both.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseDictionaryImportText(text) {
  return String(text ?? "")
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean);
}
