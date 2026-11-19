/**
 * A provider's default model. Every catalog provider names its default
 * (`defaultModel`, required by the model registry), so list order is display
 * order only; the first model is the fallback for lists with no named default.
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
