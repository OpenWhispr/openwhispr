/**
 * A provider's default model. Providers whose model list is a static registry
 * entry are ordered best-first, so position is the rule. A provider whose
 * catalog is fetched live (Tinfoil) reorders between fetches and its cached
 * list outlives any single release, so it names its default in the registry
 * and that name wins — position there is whatever the enclave served last.
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
