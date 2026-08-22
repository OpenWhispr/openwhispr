import { getModelFamilyConstraints } from "./modelFamilyConstraints";

/**
 * Per-provider dialects for turning a model's thinking off. Model-family
 * constraints (which reasoning_effort values a family accepts) come from
 * modelFamilyConstraints; this module only knows how each provider wants the
 * suppression expressed. Kept free of heavier runtime imports so the dialect
 * table stays unit-testable on its own.
 */
export interface EndpointDialect {
  key: "mistral" | "deepseek" | "cerebras";
  tokenParam: "max_tokens" | "max_completion_tokens";
  supportsTemperature: boolean;
}

/** Custom endpoints that need their own request shape, recognised by host. */
export function detectEndpointDialect(baseUrl: string | null | undefined): EndpointDialect | null {
  if (!baseUrl) return null;

  let host: string;
  try {
    const normalized = baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`;
    host = new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (host === "mistral.ai" || host.endsWith(".mistral.ai")) {
    return { key: "mistral", tokenParam: "max_tokens", supportsTemperature: true };
  }
  if (host === "deepseek.com" || host.endsWith(".deepseek.com")) {
    return { key: "deepseek", tokenParam: "max_tokens", supportsTemperature: true };
  }
  if (host === "cerebras.ai" || host.endsWith(".cerebras.ai")) {
    return { key: "cerebras", tokenParam: "max_tokens", supportsTemperature: true };
  }

  return null;
}

export function suppressThinking(
  requestBody: Record<string, unknown>,
  providerKey: string,
  model: string
): void {
  const family = getModelFamilyConstraints(model);

  if (providerKey === "gemini") {
    requestBody.reasoning_effort = "minimal";
    return;
  }

  // OpenRouter forwards unknown params to upstream backends, which may reject
  // them — use its native reasoning control instead.
  if (providerKey === "openrouter") {
    requestBody.reasoning = { enabled: false };
    return;
  }

  // Groq and Cerebras reject unknown fields outright (Cerebras 400s on
  // chat_template_kwargs, #831) and take a per-family reasoning_effort enum,
  // so send nothing unless the family is known.
  if (providerKey === "groq" || providerKey === "cerebras") {
    if (family?.reasoningEffort) {
      requestBody.reasoning_effort = family.reasoningEffort.suppressValue;
    }
    return;
  }

  // DeepSeek's API rejects reasoning_effort "none" (its enum has no off value,
  // #1260); thinking: {type} is its native switch. Family facts don't apply —
  // deepseek models on other hosts (e.g. Tinfoil) accept the generic shape.
  if (providerKey === "deepseek") {
    requestBody.thinking = { type: "disabled" };
    return;
  }

  // Mistral rejects unknown fields with a 422; reasoning_effort is its native switch.
  if (providerKey === "mistral") {
    if (family?.omitReasoningParams) return;
    requestBody.reasoning_effort = "none";
    return;
  }

  if (providerKey === "local") {
    requestBody.think = false;
  } else if (providerKey === "lan") {
    // `lan` always talks to an OpenAI-compat /v1 endpoint: the `reasoning` object
    // disables Ollama thinking; other backends drop it (flat reasoning_effort trips vLLM).
    // The effort value is the family's — gpt-oss has no off switch, so "none" would
    // contradict the "low" cleanup pin the same body carries.
    requestBody.reasoning = { effort: family?.reasoningEffort?.suppressValue ?? "none" };
  } else {
    requestBody.reasoning_effort = family?.reasoningEffort?.suppressValue ?? "none";
  }
  requestBody.chat_template_kwargs = { enable_thinking: false };
}
