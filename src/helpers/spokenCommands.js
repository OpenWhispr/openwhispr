/**
 * Spoken command detection for hands-free control (issue #1308).
 *
 * Recognises a fixed set of voice commands from the dictated transcript and
 * maps them to platform-neutral key descriptors that ClipboardManager can
 * inject via the fast-paste binaries.
 *
 * Detection strategy — exact whole-transcript match only:
 *   The entire trimmed, lower-cased transcript must equal one of the command
 *   phrases.  This prevents incidental phrase matches inside ordinary
 *   sentences (e.g. "I pressed enter the competition" must NOT fire Enter).
 *   Trailing punctuation (., !, ?) is stripped before comparison so that
 *   "Submit." is treated the same as "Submit".
 *
 * Extend SPOKEN_COMMANDS to add more commands; no other changes are needed.
 */

/**
 * @typedef {Object} SpokenCommand
 * @property {string[]} phrases   - Recognised spoken phrases (lower-case).
 * @property {string}   key       - Platform-neutral key name sent to the fast-paste binary.
 * @property {string}   label     - Human-readable label for logging / UI.
 */

/** @type {SpokenCommand[]} */
const SPOKEN_COMMANDS = [
  {
    // Submit / send the current field — fires a bare Return keystroke.
    phrases: ["press enter", "press return", "submit", "send it", "send message"],
    key: "Return",
    label: "Enter",
  },
  {
    // Soft newline — Shift+Return does NOT submit in most chat apps.
    phrases: ["new line", "new paragraph", "line break"],
    key: "Shift+Return",
    label: "Shift+Enter",
  },
  {
    // Dismiss dialogs / cancel.
    phrases: ["press escape", "escape", "cancel"],
    key: "Escape",
    label: "Escape",
  },
  {
    // Move focus to the next field.
    phrases: ["press tab", "next field", "tab"],
    key: "Tab",
    label: "Tab",
  },
  {
    // Delete the character before the cursor.
    phrases: ["press backspace", "delete that", "backspace"],
    key: "BackSpace",
    label: "Backspace",
  },
];

// Build a flat lookup map: lower-case phrase → SpokenCommand
// (constructed once at module load; O(1) detection at runtime)
/** @type {Map<string, SpokenCommand>} */
const COMMAND_MAP = new Map();
for (const cmd of SPOKEN_COMMANDS) {
  for (const phrase of cmd.phrases) {
    COMMAND_MAP.set(phrase, cmd);
  }
}

/**
 * Strips trailing sentence-ending punctuation from a string.
 *
 * @param {string} text
 * @returns {string}
 */
function stripTrailingPunctuation(text) {
  return text.replace(/[.!?,;]+$/, "");
}

/**
 * Detects whether `text` is a recognised spoken command.
 *
 * @param {string} text - The final (post-cleanup) transcript.
 * @returns {SpokenCommand|null} The matched command, or null if not a command.
 */
function detectSpokenCommand(text) {
  if (!text || typeof text !== "string") return null;

  const normalized = stripTrailingPunctuation(text.trim()).toLowerCase();
  if (!normalized) return null;

  return COMMAND_MAP.get(normalized) ?? null;
}

/**
 * Returns the full list of spoken commands (for display in settings / docs).
 *
 * @returns {SpokenCommand[]}
 */
function getSpokenCommands() {
  return SPOKEN_COMMANDS;
}

module.exports = { detectSpokenCommand, getSpokenCommands, SPOKEN_COMMANDS };
