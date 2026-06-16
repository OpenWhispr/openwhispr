// Pure spacing rules applied between previously-typed text and a paste.
// "prepend" mode needs the char before the cursor (read via Accessibility on
// macOS); "append" mode is the platform-agnostic fallback.

const OPENING_CHARS = new Set([" ", "\t", "\n", "\r", "(", "[", "{", "<", '"', "'", "`", "“", "‘"]);
const LEADING_PUNCTUATION = new Set([",", ".", "!", "?", ";", ":", ")", "]", "}", "%", "”", "’"]);

function applySmartSpacing({ text, mode, precedingChar }) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (mode === "prepend") return applyPrepend(text, precedingChar);
  if (mode === "append") return applyAppend(text);
  return text;
}

function applyPrepend(text, precedingChar) {
  if (precedingChar == null || precedingChar === "") return text;
  if (/^\s/.test(text)) return text;
  if (OPENING_CHARS.has(precedingChar)) return text;
  // Don't separate prior text from closing punctuation: "Hello" + ", world".
  if (LEADING_PUNCTUATION.has(text[0])) return text;
  return " " + text;
}

function applyAppend(text) {
  if (/\s$/.test(text)) return text;
  return text + " ";
}

module.exports = { applySmartSpacing };
