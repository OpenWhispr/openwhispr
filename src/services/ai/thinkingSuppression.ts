import type { ReasoningConfig } from "../BaseReasoningService";
import type { InferenceMode } from "../../types/electron";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";
import { detectEndpointDialect, suppressThinking } from "./thinkingSuppressionDialects";

/**
 * Whether Settings offers "Disable thinking output" for this route: any
 * endpoint that may honour it, but a known model only when it can think on request.
 */
export function offersThinkingToggle(
  mode: InferenceMode,
  provider: string,
  model: string
): boolean {
  if (mode === "self-hosted") return true;
  if (mode === "providers") {
    return (
      provider === "custom" || provider === "openrouter" || !!getCloudModel(model)?.supportsThinking
    );
  }
  return mode === "local" && !!getLocalModel(model)?.supportsThinking;
}

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
