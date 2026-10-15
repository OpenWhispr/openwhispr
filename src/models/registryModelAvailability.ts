import { getRegistryData } from "./registryData.js";
import { wasPublishedModel } from "./registryModelHistory.ts";

export const MODEL_CATALOG_UNAVAILABLE = "MODEL_CATALOG_UNAVAILABLE";
export const MODEL_CATALOG_UNAVAILABLE_MESSAGE_KEY =
  "onboarding.rehaul.provider.errors.modelNotFound";

export function isPublishedTranscriptionModelUnavailable(
  provider: string,
  model: string | undefined
): boolean {
  const id = model?.trim();
  if (!id || !wasPublishedModel("transcriptionProviders", provider, id)) return false;
  return !getRegistryData()
    .transcriptionProviders.find((entry) => entry.id === provider)
    ?.models.some((entry) => entry.id === id);
}
