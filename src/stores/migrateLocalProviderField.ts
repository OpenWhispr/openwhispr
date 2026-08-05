import modelRegistryData from "../models/modelRegistryData.json" with { type: "json" };

/**
 * The model-family ids served by the bundled llama.cpp server. Derived from the
 * registry so the set cannot drift as families are added or renamed.
 */
export const LOCAL_MODEL_FAMILY_IDS: ReadonlySet<string> = new Set(
  modelRegistryData.localProviders.map((provider) => provider.id)
);

/**
 * Only the four LLM scopes. "mistral" is both a local model family and a real
 * cloud transcription provider id, so a transcription provider key holding it
 * is correct and must never be rewritten.
 */
const LLM_PROVIDER_KEYS = [
  "cleanupProvider",
  "noteFormattingProvider",
  "dictationAgentProvider",
  "chatAgentProvider",
] as const;

const SENTINEL_KEY = "_localProviderFieldMigrated";

export interface MigrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The local model picker used to persist a model *family* ("gemma", "qwen") into
 * the provider field, which then reached the main process as
 * NOTE_FORMATTING_PROVIDER=gemma and failed every inference call. The provider
 * for every locally-served family is "local"; rewrite the ones already stored.
 *
 * Sentinel-guarded so a value the user deliberately sets later is never touched.
 */
export function migrateLocalProviderField(storage: MigrationStorage): void {
  if (storage.getItem(SENTINEL_KEY) === "1") return;

  for (const key of LLM_PROVIDER_KEYS) {
    const value = storage.getItem(key);
    if (value && LOCAL_MODEL_FAMILY_IDS.has(value)) {
      storage.setItem(key, "local");
    }
  }

  storage.setItem(SENTINEL_KEY, "1");
}
