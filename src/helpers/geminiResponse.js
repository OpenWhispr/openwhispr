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

// Classifies a generateContent response so the provider maps kinds to outcomes. See #1341.
export function assessGeminiResponse(response) {
  const { text, finishReason, usage } = extractGeminiCandidateText(response);
  const tokenLimitHit = isGeminiTokenLimitHit(finishReason);
  if (!text) {
    return { kind: tokenLimitHit ? "empty_token_limit" : "empty", text, finishReason, usage };
  }
  return { kind: tokenLimitHit ? "truncated" : "ok", text, finishReason, usage };
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// Lowest thinking level the model accepts when suppressing; Gemini 3 Pro rejects "minimal".
export function geminiSuppressedThinkingLevel(modelDef) {
  return THINKING_LEVELS.includes(modelDef?.minThinkingLevel)
    ? modelDef.minThinkingLevel
    : "minimal";
}

// Cleanup always suppresses thinking to the lowest level the model accepts;
// agent prompts only when the user disabled it. See #1341.
export function resolveGeminiThinkingConfig(config, modelDef) {
  if (!modelDef?.supportsThinking) return undefined;
  const isCleanup = !config?.systemPrompt;
  if (!isCleanup && config?.disableThinking !== true) return undefined;
  return { thinkingLevel: geminiSuppressedThinkingLevel(modelDef), includeThoughts: false };
}
