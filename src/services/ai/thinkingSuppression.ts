import type { ReasoningConfig } from "../BaseReasoningService";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";

// `lan` always talks to an OpenAI-compat /v1 endpoint: the `reasoning` object
// disables Ollama thinking; other backends drop it (flat reasoning_effort trips vLLM).
function suppressThinking(requestBody: Record<string, unknown>, providerKey: string): void {
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

  if (providerKey === "local") {
    requestBody.think = false;
  } else if (providerKey === "lan") {
    requestBody.reasoning = { effort: "none" };
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
