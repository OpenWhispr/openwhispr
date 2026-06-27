// Shared parsing/serialization for hotkey *lists*.
//
// A single slot (dictation, agent, voiceAgent, meeting) can be bound to more
// than one hotkey so the user can trigger the same action from different
// keyboards (issue #936). Hotkey accelerators never contain a comma (they use
// "+" as the combiner, e.g. "Control+Shift+R"), so a comma-separated string is
// an unambiguous, human-readable storage format that stays backward compatible
// with the historical single-value `.env` / localStorage entries: a legacy
// value with no comma simply parses to a one-element list.

const HOTKEY_LIST_SEPARATOR = ",";

/**
 * Normalize a stored hotkey value (string, comma-separated string, or array)
 * into a clean array of hotkey strings: trimmed, de-duplicated, empties removed,
 * original order preserved.
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
  for (const part of raw) {
    const hotkey = part.trim();
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
