// Parsing/serialization for hotkey lists (#936), stored as comma-separated
// strings — backward compatible with legacy single-value entries. The comma
// KEY is itself a valid hotkey (e.g. "Control+,"): no accelerator legitimately
// ends with "+", so a split segment ending in "+" gets its comma restored.
//
// Keep in sync with the renderer twin in src/utils/hotkeys.ts.

const HOTKEY_LIST_SEPARATOR = ",";

/**
 * Normalize a stored hotkey value (string, comma-separated string, or array)
 * into a clean array: trimmed, de-duplicated, empties removed, order preserved.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
function parseHotkeyList(value) {
  if (value == null) return [];

  const raw = Array.isArray(value)
    ? value.flatMap((item) => String(item).split(HOTKEY_LIST_SEPARATOR))
    : String(value).split(HOTKEY_LIST_SEPARATOR);

  const seen = new Set();
  const result = [];
  for (let i = 0; i < raw.length; i++) {
    let hotkey = raw[i].trim();
    // A non-final segment ending in "+" lost its comma key to the split.
    if (hotkey.endsWith("+") && i < raw.length - 1) {
      hotkey += HOTKEY_LIST_SEPARATOR;
    }
    if (!hotkey || seen.has(hotkey)) continue;
    seen.add(hotkey);
    result.push(hotkey);
  }
  return result;
}

/**
 * Serialize a hotkey value into the canonical comma-separated storage string.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string}
 */
function serializeHotkeyList(value) {
  return parseHotkeyList(value).join(HOTKEY_LIST_SEPARATOR);
}

module.exports = {
  parseHotkeyList,
  serializeHotkeyList,
};
