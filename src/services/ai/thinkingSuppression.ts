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

// `chat_template_kwargs` is only understood by local inference servers
// (llama.cpp, vLLM, SGLang, LM Studio). Cloud OpenAI-compatible APIs such as
// Groq and Cerebras do strict request validation and reject it with
// "property 'chat_template_kwargs' is unsupported".
function isLocalServer(providerKey: string): boolean {
  return providerKey === "local" || providerKey === "lan";
}

// `reasoning_effort: "none"` is not universally supported. Groq and Cerebras
// only accept "low" | "medium" | "high" and return a 400 for "none". Use "low"
// as the safe minimum, except for providers verified to accept "none" (xAI).
function minimalReasoningEffort(providerKey: string): string {
  return providerKey === "xai" ? "none" : "low";
}

function suppressThinking(requestBody: Record<string, unknown>, providerKey: string): void {
  if (providerKey === "gemini") {
    requestBody.reasoning_effort = "minimal";
    return;
  }

  if (usesOllamaDialect(providerKey)) {
    requestBody.think = false;
  } else {
    requestBody.reasoning_effort = minimalReasoningEffort(providerKey);
  }

  if (isLocalServer(providerKey)) {
    requestBody.chat_template_kwargs = { enable_thinking: false };
  }
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
