// Paste-time spacing: append a trailing space so the next dictation's paste
// doesn't run into this one. Kept pure so the rules stay unit-testable.

function applySmartSpacing(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (/\s$/.test(text)) return text;
  return text + " ";
}

module.exports = { applySmartSpacing };
