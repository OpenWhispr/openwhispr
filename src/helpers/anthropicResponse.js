// Text extraction for Anthropic Messages API responses. `content` is a block
// array whose shape varies run to run: it can be empty (max_tokens hit before
// any text), or lead with non-text blocks (thinking, tool_use), so
// `content[0].text` is not a safe read (#1653).

// Returns the trimmed concatenation of all text blocks, or null when the
// response contains no text block at all.
function extractAnthropicText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const parts = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
  if (parts.length === 0) return null;
  return parts.join("").trim();
}

function describeMissingAnthropicText(data) {
  const stopReason = data?.stop_reason;
  if (stopReason === "max_tokens") {
    return "Anthropic returned no text before hitting the max_tokens limit";
  }
  return stopReason
    ? `Anthropic response contained no text content (stop_reason: ${stopReason})`
    : "Anthropic response contained no text content";
}

module.exports = { extractAnthropicText, describeMissingAnthropicText };
