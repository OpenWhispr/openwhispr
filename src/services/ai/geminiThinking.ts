// Shared mapping from a model's registry thinking metadata + the user's
// "Disable thinking" toggle to a Gemini `thinkingConfig`. Used by both the
// native REST cleanup path (`inferenceProviders/gemini.ts`) and the AI-SDK
// agent stream path (`ReasoningService.ts`) so the behavior stays identical.
//
// @sync(gemini-thinking-config) callers: gemini.ts, ReasoningService.ts

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

// A `type` (not `interface`) so it stays assignable to the AI SDK's
// `providerOptions.google` value, which requires an index-signature/JSON-object
// shape — named interfaces are rejected there.
export type GeminiThinkingConfig = {
  thinkingLevel: GeminiThinkingLevel;
  includeThoughts: boolean;
};

// The subset of a CloudModelDefinition this mapping depends on. Kept structural
// (rather than importing CloudModelDefinition) so the function is pure and unit
// testable without the model registry.
interface GeminiThinkingModelInfo {
  supportsThinking?: boolean;
  thinkingLevels?: { disabled: string; enabled: string };
}

/**
 * Resolve the Gemini `thinkingConfig`, or `undefined` to leave thinking at the
 * API default.
 *
 * - Models that declare `thinkingLevels` (Gemma 4, which always thinks and only
 *   accepts "minimal"/"high") get a two-way mapping: disabled -> minimal (fast),
 *   enabled -> high. These models think on every call, so this also drives the
 *   user-facing Minimal/High selector.
 * - Models that only declare `supportsThinking` (e.g. Gemini 3.5 Flash) are only
 *   pushed down to "minimal" when the user disables thinking; otherwise they keep
 *   the API default (no thinkingConfig sent).
 * - Models with neither flag are never sent a thinkingConfig.
 *
 * `includeThoughts: false` is always set so Gemini never echoes thought-summary
 * parts back to us — the dictation/agent output should only contain the answer.
 */
export function resolveGeminiThinkingConfig(
  modelDef: GeminiThinkingModelInfo | undefined,
  disableThinking: boolean | undefined
): GeminiThinkingConfig | undefined {
  const thinkingLevels = modelDef?.thinkingLevels;
  if (thinkingLevels) {
    return {
      thinkingLevel: (disableThinking
        ? thinkingLevels.disabled
        : thinkingLevels.enabled) as GeminiThinkingLevel,
      includeThoughts: false,
    };
  }

  if (disableThinking === true && modelDef?.supportsThinking) {
    return { thinkingLevel: "minimal", includeThoughts: false };
  }

  return undefined;
}
