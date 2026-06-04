import type { ReasoningConfig } from "../BaseReasoningService";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";
import thinkingSuppressionPolicy from "./thinkingSuppressionPolicy.js";

const { applyThinkingSuppressionFields } = thinkingSuppressionPolicy;

// Strict OpenAI-compatible servers (DeepSeek, LM Studio, vLLM, LocalAI) reject
// unknown fields like `think` with "property 'think' is unsupported". Only
// Ollama-native servers accept `think`.
// Other OpenAI-compatible servers may accept reasoning controls, but many reject
// `none` because their enum only includes effort levels such as low/medium/high.
// The `lan` provider defaults to Ollama dialect, but legacy users who
// configured Self-Hosted as "openai-compatible" still route through `lan`
// — honor that flag so their backend doesn't reject the request.
function usesOllamaDialect(providerKey: string): boolean {
  if (providerKey === "local") return true;
  if (providerKey !== "lan") return false;
  if (typeof window === "undefined") return true;
  return window.localStorage?.getItem("remoteReasoningType") !== "openai-compatible";
}

function suppressThinking(requestBody: Record<string, unknown>, providerKey: string): void {
  const suppressionProvider = usesOllamaDialect(providerKey) ? "local" : providerKey;
  applyThinkingSuppressionFields(requestBody, suppressionProvider);
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
