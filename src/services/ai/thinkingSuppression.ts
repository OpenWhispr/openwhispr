import type { ReasoningConfig } from "../BaseReasoningService";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";

// Sends both `reasoning_effort` (OpenAI/Groq dialect) and `think` (Ollama
// dialect); servers ignore unknown fields. Skips known non-thinking models
// to avoid suppressing reasoning on models like gpt-5 where the user toggle
// is hidden but the default value still applies.
export function applyThinkingSuppression(
  requestBody: Record<string, unknown>,
  model: string,
  provider: string,
  config: ReasoningConfig
): void {
  const cloudModel = getCloudModel(model);
  const curatedGroqSuppress = !!cloudModel?.disableThinking && provider.toLowerCase() === "groq";

  if (curatedGroqSuppress) {
    requestBody.reasoning_effort = "none";
    requestBody.think = false;
    return;
  }

  if (config.disableThinking !== true) return;

  const localModel = getLocalModel(model);
  const knownModel = cloudModel || localModel;
  if (knownModel && !knownModel.supportsThinking) return;

  requestBody.reasoning_effort = "none";
  requestBody.think = false;
}
