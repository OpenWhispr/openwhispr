import type { ReasoningConfig } from "../BaseReasoningService";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";

// Strict OpenAI-compatible servers (Groq, LM Studio, vLLM, LocalAI) reject
// unknown fields like `think` with "property 'think' is unsupported". Only
// Ollama-native servers accept `think`; everyone else uses `reasoning_effort`.
// The `lan` provider defaults to Ollama dialect, but legacy users who
// configured Self-Hosted as "openai-compatible" still route through `lan`
// — honor that flag so their backend doesn't reject the request.
function usesOllamaDialect(providerKey: string): boolean {
  if (providerKey === "local") return true;
  if (providerKey !== "lan") return false;
  if (typeof window === "undefined") return true;
  return window.localStorage?.getItem("remoteReasoningType") !== "openai-compatible";
}

// Endpoints with strict OpenAI-compatible validation that reject BOTH
// `chat_template_kwargs` and `reasoning_effort: "none"` — they only accept
// `low` | `medium` | `high`. Verified against the live Groq and Cerebras
// `gpt-oss-120b` APIs.
//
// `groq` is a first-class provider. Cerebras is configured as a custom
// OpenAI-compatible endpoint, so it is matched by hostname only — other custom
// endpoints (e.g. self-hosted vLLM / SGLang, which DO accept
// `chat_template_kwargs`) must keep their existing behaviour.

// Match Cerebras by parsed hostname rather than a substring test, so a
// look-alike host or a URL that merely contains "cerebras.ai" in its path
// (e.g. "https://evil.example/cerebras.ai" or "https://cerebras.ai.attacker.com")
// is not mistaken for the real endpoint.
function isCerebrasEndpoint(baseUrl: string | undefined): boolean {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    try {
      // Tolerate scheme-less values like "api.cerebras.ai/v1".
      host = new URL(`https://${raw}`).hostname.toLowerCase();
    } catch {
      return false;
    }
  }
  return host === "cerebras.ai" || host.endsWith(".cerebras.ai");
}

function isStrictReasoningEndpoint(providerKey: string, config: ReasoningConfig): boolean {
  if (providerKey === "groq") return true;
  if (providerKey === "custom") return isCerebrasEndpoint(config.baseUrl);
  return false;
}

function suppressThinking(
  requestBody: Record<string, unknown>,
  providerKey: string,
  strict: boolean
): void {
  if (providerKey === "gemini") {
    requestBody.reasoning_effort = "minimal";
    return;
  }

  if (strict) {
    // Groq / Cerebras: send the lowest accepted effort and omit
    // `chat_template_kwargs` (both rejected by these endpoints).
    requestBody.reasoning_effort = "low";
    return;
  }

  if (usesOllamaDialect(providerKey)) {
    requestBody.think = false;
  } else {
    requestBody.reasoning_effort = "none";
  }
  requestBody.chat_template_kwargs = { enable_thinking: false };
}

export function applyThinkingSuppression(
  requestBody: Record<string, unknown>,
  model: string,
  provider: string,
  config: ReasoningConfig
): void {
  const providerKey = provider.toLowerCase();
  const strict = isStrictReasoningEndpoint(providerKey, config);
  const cloudModel = getCloudModel(model);

  if (cloudModel?.disableThinking && providerKey === "groq") {
    suppressThinking(requestBody, providerKey, strict);
    return;
  }

  if (config.disableThinking !== true) return;

  const localModel = getLocalModel(model);
  const knownModel = cloudModel || localModel;
  if (knownModel && !knownModel.supportsThinking) return;

  suppressThinking(requestBody, providerKey, strict);
}
