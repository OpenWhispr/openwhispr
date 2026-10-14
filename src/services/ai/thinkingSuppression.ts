import type { ReasoningConfig } from "../BaseReasoningService";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";
import { detectEndpointDialect, suppressThinking } from "./thinkingSuppressionDialects";

export function isThinkingSuppressed(model: string, config: ReasoningConfig): boolean {
  const cloudModel = getCloudModel(model);

  // A registry model flagged disableThinking is force-suppressed on every
  // provider — scoping this to one provider is the #1611 bug pattern.
  if (cloudModel?.disableThinking) return true;

  if (config.disableThinking !== true) return false;

  const knownModel = cloudModel || getLocalModel(model);
  return !knownModel || !!knownModel.supportsThinking;
}

/** Returns whether it suppressed thinking. */
export function applyThinkingSuppression(
  requestBody: Record<string, unknown>,
  model: string,
  provider: string,
  config: ReasoningConfig,
  baseUrl?: string
): boolean {
  if (!isThinkingSuppressed(model, config)) return false;

  // A known endpoint host wins over the generic provider dialect.
  const providerKey = detectEndpointDialect(baseUrl)?.key ?? provider.toLowerCase();
  suppressThinking(requestBody, providerKey, model);
  return true;
}
