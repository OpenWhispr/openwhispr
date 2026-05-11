import type { ReasoningConfig } from "../BaseReasoningService";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";

// Groq strictly validates request bodies and rejects unknown fields like
// `think` ("property 'think' is unsupported"). Only Ollama-dialect providers
// accept `think`; OpenAI-compatible providers use `reasoning_effort`.
const OLLAMA_DIALECT_PROVIDERS = new Set(["local", "lan"]);

function suppressThinking(requestBody: Record<string, unknown>, providerKey: string): void {
  if (OLLAMA_DIALECT_PROVIDERS.has(providerKey)) {
    requestBody.think = false;
  } else {
    requestBody.reasoning_effort = "none";
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
