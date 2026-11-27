/** @typedef {"tap" | "push" | "push-double-tap"} DictationActivationMode */

/**
 * @param {unknown} mode
 * @returns {DictationActivationMode}
 */
export function normalizeDictationActivationMode(mode) {
  return mode === "push" || mode === "push-double-tap" ? mode : "tap";
}
