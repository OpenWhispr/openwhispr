/**
 * Request constraints that belong to a model family, independent of which
 * provider serves it. Storing a family fact inside a provider branch is what
 * broke Tinfoil gpt-oss (#1611: the "no reasoning off switch" rule lived under
 * `providerKey === "groq"`, so every other provider sent the rejected "none").
 * New family facts must land here, never in a provider conditional.
 *
 * Kept free of runtime imports so the table stays unit-testable on its own,
 * like thinkingSuppressionDialects.
 */
export interface ModelFamilyConstraints {
  family: "gpt-oss" | "gpt-5" | "qwen" | "magistral";
  reasoningEffort?: {
    /** Value that best approximates "thinking off" for reasoning_effort. */
    suppressValue: string;
    /**
     * Effort for deterministic transforms (cleanup, selection edits). gpt-oss
     * defaults to medium; low cuts hidden reasoning tokens (latency) and the
     * tendency to answer the transcript instead of cleaning it. At higher
     * efforts gpt-oss can leave the whole reply in the reasoning channel and
     * return whitespace content, failing selection edits.
     */
    cleanupValue?: string;
  };
  /** Family reasons natively and may reject reasoning params outright. */
  omitReasoningParams?: boolean;
}

const FAMILIES: Array<ModelFamilyConstraints & { match: RegExp }> = [
  {
    family: "gpt-5",
    // Boundary keeps provider-prefixed ids (openai/gpt-5-mini) in and ids that
    // merely contain the substring out; gpt-oss has its own entry below.
    match: /(^|\/)gpt-5/,
    // gpt-5* are reasoning models whose default effort spends seconds of
    // hidden reasoning per request — on a dictation cleanup that is nearly
    // all of the user-visible paste latency. "minimal" keeps the transform
    // fast; a backend that rejects the value degrades gracefully via the
    // param-strip ladder in chatRequestBody.
    reasoningEffort: { suppressValue: "minimal", cleanupValue: "minimal" },
  },
  {
    family: "gpt-oss",
    match: /gpt-oss/,
    // gpt-oss accepts low|medium|high only; it has no off switch. Confirmed
    // live on Groq and Tinfoil (#1611): "none" is a 400 on both.
    reasoningEffort: { suppressValue: "low", cleanupValue: "low" },
  },
  {
    family: "qwen",
    match: /qwen/,
    // qwen3 accepts none|default only (Groq's enum; "none" is also what the
    // generic dialect sends everywhere, so the fact is provider-agnostic).
    reasoningEffort: { suppressValue: "none" },
  },
  {
    family: "magistral",
    match: /magistral/,
    // Legacy magistral models reason natively and may reject reasoning_effort.
    // Verified only against the Mistral API, so the mistral dialect is the
    // sole consumer today — a canary run should confirm other hosts before
    // the generic dialect honors it.
    omitReasoningParams: true,
  },
];

export function getModelFamilyConstraints(
  model: string | null | undefined
): ModelFamilyConstraints | null {
  const id = (model || "").toLowerCase();
  if (!id) return null;
  return FAMILIES.find((f) => f.match.test(id)) ?? null;
}
