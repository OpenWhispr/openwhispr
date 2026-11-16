import { getCloudModel, modelRegistry, type ReasoningEffortCapability } from "./ModelRegistry";
import { getModelFamilyConstraints } from "../services/ai/modelFamilyConstraints";
import { matchesHost } from "../utils/urlUtils";

export const AUTO_REASONING_EFFORT = "";

export const OPEN_ENDPOINT_PROVIDERS = new Set(["custom", "openrouter"]);

const OPEN_ENDPOINT_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh"];

// Hosts whose levels are fixed by the API whatever the model, from the provider docs.
const HOST_OPTIONS: Array<{ host: string; options: string[] }> = [
  // grok-4.5 and later; reasoning can't be turned off, and grok-4.5 reads xhigh as high.
  { host: "x.ai", options: ["low", "medium", "high", "xhigh"] },
  // DeepSeek rejects "none" (#1260) and folds every other level into low, high or
  // max. Max is left out: the AI SDK's Chat Completions options refuse it.
  { host: "deepseek.com", options: ["low", "high"] },
];

export function getReasoningEffortCapability(
  provider: string,
  model: string,
  endpoint?: string | null
): ReasoningEffortCapability | null {
  // Custom endpoints and OpenRouter serve models the registry may not describe,
  // so they offer the host's levels, else the family's, else the registry's,
  // else the OpenAI-style list. The server's default is unknown, so none is named.
  if (OPEN_ENDPOINT_PROVIDERS.has(provider)) {
    const hostOptions = HOST_OPTIONS.find(({ host }) => matchesHost(endpoint, host))?.options;
    if (hostOptions) return { options: hostOptions };
    const family = getModelFamilyConstraints(model);
    if (family?.omitReasoningParams) return null;
    // A Custom turn streams through the AI SDK's Chat Completions options,
    // which take no "max"; OpenRouter's own reasoning object does.
    const registryOptions = getCloudModel(model, provider)?.reasoningEffort?.options.filter(
      (option) => provider === "openrouter" || OPEN_ENDPOINT_OPTIONS.includes(option)
    );
    return {
      options: family?.reasoningEffort?.options ?? registryOptions ?? OPEN_ENDPOINT_OPTIONS,
    };
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
