// Strip <think>...</think> reasoning blocks emitted by reasoning models served
// over OpenAI-compatible (self-hosted / LAN) endpoints.
//
// The streaming path (processTextStreaming) and the local GGUF bridge
// (localReasoningBridge.js) already strip these, but the non-streaming
// callChatCompletionsApi path did not. That leaked reasoning into cleanup /
// note-formatting output and — because generateNoteTitle discards any title
// >= 100 chars — silently suppressed generated note titles for self-hosted
// reasoning models (the note content updated, the name never did).
//
// Mirrors the regex used by localReasoningBridge.js so all paths behave the same.
export function stripThinkingTags(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}
