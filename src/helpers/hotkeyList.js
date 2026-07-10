// Shared parsing/serialization for hotkey *lists*.
//
// A single slot (dictation, agent, voiceAgent, meeting) can be bound to more
// than one hotkey so the user can trigger the same action from different
// keyboards (issue #936). Hotkeys are stored as a comma-separated string, which
// stays backward compatible with the historical single-value `.env` /
// localStorage entries: a legacy value with no comma simply parses to a
// one-element list.
//
// The comma KEY itself is a valid hotkey key (e.g. "Control+,"), so a split
// segment ending in "+" means the split consumed a comma key, not a separator —
// no accelerator legitimately ends with "+". Parsing restores that comma.
//
// Keep in sync with the renderer twin in src/utils/hotkeys.ts.

const HOTKEY_LIST_SEPARATOR = ",";

/**
 * Normalize a stored hotkey value (string, comma-separated string, or array)
 * into a clean array of hotkey strings: trimmed, de-duplicated, empties removed,
 * original order preserved. Comma-key hotkeys (e.g. "Control+,") survive the
 * round-trip.
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
  HOTKEY_LIST_SEPARATOR,
  parseHotkeyList,
  serializeHotkeyList,
};
