/**
 * A provider's default model. Static registry lists are ordered best-first, so
 * position is the rule; a live catalog (Tinfoil) is ordered by the provider, so
 * it names its default in the registry and that name wins instead.
 *
 * Kept import-free so the settings store can use it: ModelRegistry imports the
 * store, so the store cannot import ModelRegistry back.
 */
export function pickProviderDefaultModel<T extends { id: string }>(
  models: readonly T[] | undefined,
  defaultModelId: string | undefined
): T | undefined {
  return models?.find((model) => model.id === defaultModelId) ?? models?.[0];
}

interface ProviderWithModels {
  models?: readonly { id: string }[];
  defaultModel?: string;
}

/**
 * Empty when the provider ships no models. Takes the provider so no caller has
 * to know that naming a default is optional.
 */
export function pickDefaultModelId(provider: ProviderWithModels | undefined): string {
  return pickProviderDefaultModel(provider?.models, provider?.defaultModel)?.id ?? "";
}
