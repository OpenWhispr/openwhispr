// Response and thinking-config helpers for the Gemini generateContent path.
// Pure functions so node --test can cover them; gemini.ts wires them. See #1341.

// Joins the visible text parts of the first candidate, skipping thought parts.
export function extractGeminiCandidateText(response) {
  const candidate = response?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts
    .filter((part) => part && !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  return {
    text,
    finishReason: candidate?.finishReason || "",
    usage: response?.usageMetadata || {},
  };
}

// MAX_TOKENS means generation was cut at maxOutputTokens, even when partial text came back.
export function isGeminiTokenLimitHit(finishReason) {
  return finishReason === "MAX_TOKENS";
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// Cleanup always suppresses thinking to the lowest level the model accepts;
// agent prompts only when the user disabled it. See #1341.
export function resolveGeminiThinkingConfig(config, modelDef) {
  if (!modelDef?.supportsThinking) return undefined;
  const isCleanup = !config?.systemPrompt;
  if (!isCleanup && config?.disableThinking !== true) return undefined;
  const thinkingLevel = THINKING_LEVELS.includes(modelDef.minThinkingLevel)
    ? modelDef.minThinkingLevel
    : "minimal";
  return { thinkingLevel, includeThoughts: false };
}
