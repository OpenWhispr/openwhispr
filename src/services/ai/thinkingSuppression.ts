import type { ReasoningConfig } from "../BaseReasoningService";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";
import { detectEndpointDialect, suppressThinking } from "./thinkingSuppressionDialects";

export function applyThinkingSuppression(
  requestBody: Record<string, unknown>,
  model: string,
  provider: string,
  config: ReasoningConfig,
  baseUrl?: string
): void {
  // A known endpoint host wins over the generic provider dialect.
  const providerKey = detectEndpointDialect(baseUrl)?.key ?? provider.toLowerCase();
  const cloudModel = getCloudModel(model);

  // A registry model flagged disableThinking is force-suppressed on every
  // provider — scoping this to one provider is the #1611 bug pattern.
  if (cloudModel?.disableThinking) {
    suppressThinking(requestBody, providerKey, model);
    return;
  }

  if (config.disableThinking !== true) return;

  // A known model without a thinking mode needs no suppression — except on
  // llama-server, which decides "think by default" per template on its own
  // (b9763: --reasoning auto + the template's supports_thinking) and ignores
  // chat_template_kwargs.enable_thinking when the template doesn't read it.
  // There the registry flag can only lose (Gemma 4 shipped without it and
  // thinks unless told not to), so the off switch always goes out.
  const localModel = getLocalModel(model);
  const knownModel = cloudModel || localModel;
  if (knownModel && !knownModel.supportsThinking && providerKey !== "local") return;

  suppressThinking(requestBody, providerKey, model);
}
