import { getRegistryData, getRetiredModel } from "./registryData.js";

// The model a retired selection moves to: its named replacement while that is still
// offered, otherwise the provider's default. Null when the selection is not retired.
export function retiredReplacement(section, providerId, modelId, providers) {
  const retired = getRetiredModel(section, providerId, modelId);
  if (!retired) return null;
  const provider = (providers ?? getRegistryData()[section]).find((p) => p.id === providerId);
  const models = provider?.models ?? [];
  if (retired.replacement && models.some((model) => model.id === retired.replacement))
    return retired.replacement;
  return (models.find((model) => model.id === provider?.defaultModel) ?? models[0])?.id ?? null;
}

// An ID no provider in the section offers or has retired. It may be a model added
// remotely whose catalog has not loaded yet, so a saved choice of it is left alone
// rather than swapped for a default.
export function isUnknownModel(section, modelId, providers) {
  const list = providers ?? getRegistryData()[section];
  return (
    !list.some((provider) => provider.models.some((model) => model.id === modelId)) &&
    !list.some((provider) => getRetiredModel(section, provider.id, modelId))
  );
}
