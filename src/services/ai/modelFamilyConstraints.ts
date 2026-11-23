import { matchesHost } from "../../utils/urlUtils";

/**
 * Model-family defaults shared across providers. A host can override a family
 * constraint when its API supports different controls for the same model.
 * Keeping defaults here, not in a provider branch, avoids #1611, where a gpt-oss
 * rule scoped to `providerKey === "groq"` let every other provider send the
 * rejected "none".
 */
export interface ModelFamilyConstraints {
  family: "gpt-oss" | "qwen" | "magistral" | "glm-5.3" | "kimi-k3.1" | "gemini-no-minimal";
  reasoningEffort?: {
    /** Value that best approximates "thinking off" for reasoning_effort. */
    suppressValue: string;
    /** Levels a Custom or OpenRouter endpoint offers for this family. */
    options?: string[];
    /**
     * Effort for deterministic transforms (cleanup, selection edits). gpt-oss
     * defaults to medium; low cuts hidden reasoning tokens (latency) and the
     * tendency to answer the transcript instead of cleaning it. At higher
     * efforts gpt-oss can leave the whole reply in the reasoning channel and
     * return whitespace content, failing selection edits.
     */
    cleanupValue?: string;
    /**
     * Effort sent while thinking is on, for a family whose server default
     * reasons past the app's output caps. Without it the server's default applies.
     */
    defaultValue?: string;
  };
  /** Family reasons natively and may reject reasoning params outright. */
  omitReasoningParams?: boolean;
}

const FAMILIES: Array<ModelFamilyConstraints & { match: RegExp }> = [
  {
    family: "gpt-oss",
    match: /gpt-oss/,
    // gpt-oss accepts low|medium|high only; it has no off switch. Confirmed
    // live on Groq and Tinfoil (#1611): "none" is a 400 on both.
    reasoningEffort: {
      suppressValue: "low",
      cleanupValue: "low",
      options: ["low", "medium", "high"],
    },
  },
  {
    family: "qwen",
    match: /qwen/,
    // "none" turns Qwen's thinking off on Groq (which also takes
    // default|low|medium|high) and in the generic dialect, so the fact is
    // provider-agnostic.
    reasoningEffort: { suppressValue: "none", options: ["none"] },
  },
  {
    family: "glm-5.3",
    match: /glm[-_]?5[-.]?3/,
    // GLM-5.3/Flash always reason: low|high|max only, no off switch.
    // "low" is the closest to off. At the server default, max, a long meeting
    // spent the whole 4,096-token notes budget thinking (#2008); at high it fit,
    // so max isn't offered either.
    reasoningEffort: { suppressValue: "low", defaultValue: "high", options: ["low", "high"] },
  },
  {
    family: "kimi-k3.1",
    match: /kimi[-_]?k3[-.]1/,
    // On Tinfoil, Kimi K3.1 Pro always reasons and takes low|high|max only; anything else,
    // "none" included, is a 400 (docs.tinfoil.sh/guides/reasoning). Its server
    // default is max, like GLM-5.3, so high stands in for it under the same caps.
    reasoningEffort: { suppressValue: "low", defaultValue: "high", options: ["low", "high"] },
  },
  {
    family: "gemini-no-minimal",
    match: /gemini-(3\.8-flash|4-argon|3\.1-pro)/,
    // These Gemini models take low|medium|high only and reject "minimal", so low
    // is the floor (ai.google.dev/gemini-api/docs/generate-content/thinking for
    // 3.8 Flash and 4 Argon; 3.1 Pro already uses low in the native provider).
    reasoningEffort: { suppressValue: "low" },
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
  model: string | null | undefined,
  endpoint?: string | null
): ModelFamilyConstraints | null {
  const id = (model || "").toLowerCase();
  if (!id) return null;
  const family = FAMILIES.find((entry) => entry.match.test(id)) ?? null;
  if (family?.family === "kimi-k3.1" && matchesHost(endpoint, "inference.verda.com")) {
    // Verda supports a true off switch (docs.verda.com/inference/models/kimi-k3-1-pro).
    // Auto leaves effort to the endpoint.
    return {
      ...family,
      reasoningEffort: { suppressValue: "none", options: ["none", "low", "high"] },
    };
  }
  return family;
}
