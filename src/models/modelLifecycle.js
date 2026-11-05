import { getRegistryData, getRetiredModel, isCatalogPending } from "./registryData.js";

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

// The local speech model a retired selection moves to: its named replacement, otherwise
// the engine's recommended or first model. Stays on the same engine, because Whisper,
// transducer and Cohere selections live in separate settings.
export function retiredLocalSpeechReplacement(section, modelId) {
  const retired = getRetiredModel(section, "", modelId);
  if (!retired) return null;
  const models = getRegistryData()[section];
  const engine = (model) => model.modelType === "cohere-transcribe";
  const offered = Object.keys(models).filter((id) => engine(models[id]) === engine(retired));
  if (offered.includes(retired.replacement)) return retired.replacement;
  return offered.find((id) => models[id].recommended) ?? offered[0] ?? null;
}

// While a catalog this app accepted before cannot be loaded (see isCatalogPending), a
// saved ID that no provider in the section offers or has retired may be one of its
// additions, so it is left alone rather than swapped for a default. Otherwise an unknown
// ID gets the usual repairs.
export function isAwaitingCatalog(section, modelId, providers) {
  if (!modelId || !isCatalogPending()) return false;
  const list = providers ?? getRegistryData()[section];
  return (
    !list.some((provider) => provider.models.some((model) => model.id === modelId)) &&
    !list.some((provider) => getRetiredModel(section, provider.id, modelId))
  );
}
