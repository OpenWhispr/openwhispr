/**
 * Per-provider dialects for turning a model's thinking off. Kept free of runtime
 * imports so the dialect table stays unit-testable on its own.
 */
export interface EndpointDialect {
  key: "mistral";
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

  return null;
}

export function suppressThinking(
  requestBody: Record<string, unknown>,
  providerKey: string,
  model: string
): void {
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

  // Groq rejects unknown fields outright and takes a different reasoning_effort
  // enum per model family, so send nothing unless the family is known.
  if (providerKey === "groq") {
    const groqModel = (model || "").toLowerCase();
    if (groqModel.includes("qwen")) {
      // qwen3 accepts none|default only.
      requestBody.reasoning_effort = "none";
    } else if (groqModel.includes("gpt-oss")) {
      // gpt-oss accepts low|medium|high only; it has no off switch.
      requestBody.reasoning_effort = "low";
    }
    return;
  }

  // Mistral rejects unknown fields with a 422; reasoning_effort is its native switch.
  if (providerKey === "mistral") {
    // Legacy magistral models reason natively and may reject reasoning_effort.
    if ((model || "").toLowerCase().includes("magistral")) return;
    requestBody.reasoning_effort = "none";
    return;
  }

  if (providerKey === "local") {
    requestBody.think = false;
  } else if (providerKey === "lan") {
    // `lan` always talks to an OpenAI-compat /v1 endpoint: the `reasoning` object
    // disables Ollama thinking; other backends drop it (flat reasoning_effort trips vLLM).
    requestBody.reasoning = { effort: "none" };
  } else {
    requestBody.reasoning_effort = "none";
  }
  requestBody.chat_template_kwargs = { enable_thinking: false };
}
