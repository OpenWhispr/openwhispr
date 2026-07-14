// Strip <think>...</think> blocks (including unterminated ones) emitted by
// reasoning models. Mirrors the regex in localReasoningBridge.js.
export function stripThinkingTags(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}
