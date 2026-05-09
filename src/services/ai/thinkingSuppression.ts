import type { ReasoningConfig } from "../BaseReasoningService";

import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";

// Sends `reasoning_effort` (OpenAI/Groq dialect), `think` (Ollama dialect),
// and `chat_template_kwargs.enable_thinking` (llama.cpp/Qwen chat-template
// dialect); servers ignore unknown fields. Skips known non-thinking models
// to avoid suppressing reasoning on models like gpt-5 where the user toggle
// is hidden but the default value still applies.
function applySuppressionHints(requestBody: Record<string, unknown>): void {
  requestBody.reasoning_effort = "none";
  requestBody.think = false;
  requestBody.chat_template_kwargs = {
    ...((requestBody.chat_template_kwargs as Record<string, unknown>) ?? {}),
    enable_thinking: false,
  };
}

export function applyThinkingSuppression(
  requestBody: Record<string, unknown>,
  model: string,
  provider: string,
  config: ReasoningConfig
): void {
  const cloudModel = getCloudModel(model);
  const curatedGroqSuppress =
    !!cloudModel?.disableThinking && provider.toLowerCase() === "groq";

  if (curatedGroqSuppress) {
    applySuppressionHints(requestBody);
    return;
  }

  if (config.disableThinking !== true) return;

  const localModel = getLocalModel(model);
  const knownModel = cloudModel || localModel;

  if (knownModel && !knownModel.supportsThinking) return;

  applySuppressionHints(requestBody);
}
