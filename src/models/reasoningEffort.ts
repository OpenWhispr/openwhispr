import { getCloudModel, type ReasoningEffortCapability } from "./ModelRegistry";

export const AUTO_REASONING_EFFORT = "";

// Custom endpoints and OpenRouter serve models the registry doesn't describe,
// so they offer the full OpenAI-style list.
const OPEN_ENDPOINT_CAPABILITY: ReasoningEffortCapability = {
  options: ["none", "minimal", "low", "medium", "high", "xhigh"],
};

export function getReasoningEffortCapability(
  provider: string,
  model: string
): ReasoningEffortCapability | null {
  if (provider === "custom" || provider === "openrouter") return OPEN_ENDPOINT_CAPABILITY;
  return getCloudModel(model)?.reasoningEffort ?? null;
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
