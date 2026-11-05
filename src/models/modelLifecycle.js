import { getRegistryData, getRetiredModel, isCatalogPending } from "./registryData.js";

// Follows named replacements to the first one still offered, since someone who skipped
// several publications can be more than one retirement behind. Null if none is.
export function offeredReplacement(section, providerId, modelId, isOffered) {
  const seen = new Set([modelId]);
  let next = getRetiredModel(section, providerId, modelId)?.replacement;
  while (next && !seen.has(next)) {
    if (isOffered(next)) return next;
    seen.add(next);
    next = getRetiredModel(section, providerId, next)?.replacement;
  }
  return null;
}

// The model a retired selection moves to: its named replacement while one is still
// offered, otherwise the provider's default. Null when the selection is not retired.
export function retiredReplacement(section, providerId, modelId, providers) {
  if (!getRetiredModel(section, providerId, modelId)) return null;
  const provider = (providers ?? getRegistryData()[section]).find((p) => p.id === providerId);
  const models = provider?.models ?? [];
  const isOffered = (id) => models.some((model) => model.id === id);
  return (
    offeredReplacement(section, providerId, modelId, isOffered) ??
    (models.find((model) => model.id === provider?.defaultModel) ?? models[0])?.id ??
    null
  );
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
  return (
    offeredReplacement(section, "", modelId, (id) => offered.includes(id)) ??
    offered.find((id) => models[id].recommended) ??
    offered[0] ??
    null
  );
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
