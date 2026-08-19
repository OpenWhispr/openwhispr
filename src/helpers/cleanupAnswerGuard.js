// Post-response guard for default-prompt cleanup: when the model answers the
// dictation instead of cleaning it, the raw transcript wins over the response.

// A cleanup rewrites the dictation in place; only an answer outgrows it by 3x
// AND 200+ chars. Shrinking (filler/repetition removal) is always legitimate.
export const ANSWER_LENGTH_RATIO = 3;
export const ANSWER_LENGTH_MARGIN_CHARS = 200;

export function isAnswerShapedCleanupResponse(inputText, responseText) {
  const input = typeof inputText === "string" ? inputText.trim() : "";
  const response = typeof responseText === "string" ? responseText.trim() : "";
  if (!input || !response) return false;
  const threshold = Math.max(
    input.length * ANSWER_LENGTH_RATIO,
    input.length + ANSWER_LENGTH_MARGIN_CHARS
  );
  return response.length > threshold;
}

// Returns the text to keep. Custom cleanup prompts may transform freely
// (translate, summarize, expand), so they bypass the shape check entirely.
export function resolveCleanupText(inputText, responseText, options = {}) {
  const { hasCustomPrompt = false, onSuspect } = options;
  if (typeof responseText !== "string" || !responseText) return inputText;
  if (!hasCustomPrompt && isAnswerShapedCleanupResponse(inputText, responseText)) {
    if (onSuspect) {
      onSuspect({
        inputLength: typeof inputText === "string" ? inputText.length : 0,
        responseLength: responseText.length,
      });
    }
    return inputText;
  }
  return responseText;
}
