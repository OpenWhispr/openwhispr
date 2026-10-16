import { modelRegistry, type ReasoningEffortCapability } from "./ModelRegistry";
import { getModelFamilyConstraints } from "../services/ai/modelFamilyConstraints";

export const AUTO_REASONING_EFFORT = "";

const OPEN_ENDPOINT_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh"];

export function getReasoningEffortCapability(
  provider: string,
  model: string
): ReasoningEffortCapability | null {
  // Custom endpoints and OpenRouter serve models the registry doesn't describe,
  // so they offer the levels the model's family accepts, else the OpenAI-style list.
  if (provider === "custom" || provider === "openrouter") {
    const family = getModelFamilyConstraints(model);
    if (family?.omitReasoningParams) return null;
    return { options: family?.reasoningEffort?.options ?? OPEN_ENDPOINT_OPTIONS };
  }
  // Only the provider's own entries, so a self-hosted server that serves a
  // registry model id never inherits a level saved for a cloud provider.
  return (
    modelRegistry
      .getCloudProviders()
      .find((cloudProvider) => cloudProvider.id === provider)
      ?.models.find((cloudModel) => cloudModel.id === model)?.reasoningEffort ?? null
  );
}

export function isReasoningEffortSupported(
  capability: ReasoningEffortCapability | null | undefined,
  value: string | null | undefined
): boolean {
  return !!capability && !!value && capability.options.includes(value);
}

export function hasSelectableReasoningEffort(
  capability: ReasoningEffortCapability | null | undefined
): capability is ReasoningEffortCapability {
  return Boolean(capability && capability.options.length > 1);
}
