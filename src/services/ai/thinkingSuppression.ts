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

// Groq and custom OpenAI-compatible endpoints (e.g. Cerebras) do strict request
// validation: both reject `chat_template_kwargs`, and only accept reasoning_effort
// `low` | `medium` | `high` (not `none`). Verified against the live Groq and
// Cerebras `gpt-oss-120b` APIs. For these providers send the lowest accepted
// effort and omit `chat_template_kwargs`. Every other provider is left unchanged.
const STRICT_REASONING_PROVIDERS = new Set(["groq", "custom"]);

function suppressThinking(requestBody: Record<string, unknown>, providerKey: string): void {
  if (providerKey === "gemini") {
    requestBody.reasoning_effort = "minimal";
    return;
  }

  if (STRICT_REASONING_PROVIDERS.has(providerKey)) {
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
  const cloudModel = getCloudModel(model);

  if (cloudModel?.disableThinking && providerKey === "groq") {
    suppressThinking(requestBody, providerKey);
    return;
  }

  if (config.disableThinking !== true) return;

  const localModel = getLocalModel(model);
  const knownModel = cloudModel || localModel;
  if (knownModel && !knownModel.supportsThinking) return;

  suppressThinking(requestBody, providerKey);
}
