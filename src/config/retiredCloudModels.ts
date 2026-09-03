/**
 * Cloud models their providers have retired. A scope still pointing at one 404s
 * on every request, so the sweep below repoints it at startup — before the
 * first request and without a network round-trip.
 *
 * This is deliberately separate from the live-catalog reconcile in
 * models/tinfoilModels.ts, which cannot cover the same ground: that one only
 * repairs a selection after a successful fetch, so it misses an offline launch
 * and loses the race against the first request of a session.
 *
 * Each provider's remap is one-shot, keyed by its own sentinel: repointing a
 * selection the user never chose is a repair, but doing it again to a model
 * they picked back would be the app arguing with them.
 *
 * When a provider retires a model, add `retired id -> replacement id` under
 * that provider, with a sentinel no other provider uses.
 */
export interface RetiredProviderModels {
  /** localStorage flag marking this provider's remap as already done. */
  migratedKey: string;
  models: Record<string, string>;
}

export const RETIRED_CLOUD_MODELS: Record<string, RetiredProviderModels> = {
  // Retired 2026-08-16. The key predates this table and is already set on
  // installed apps, so it stays exactly as it shipped.
  groq: {
    migratedKey: "_retiredGroqModelsMigrated",
    models: {
      "qwen/qwen3-32b": "openai/gpt-oss-120b",
      "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
      "llama-3.1-8b-instant": "openai/gpt-oss-20b",
    },
  },
  // Retired 2026-09-10, and already absent from Tinfoil's live /v1/models.
  tinfoil: {
    migratedKey: "_retiredTinfoilModelsMigrated",
    models: { "glm-5-2": "glm-5-3" },
  },
};

interface RetiredModelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ScopeStorageKeys {
  provider: string;
  model: string;
}

/**
 * Repoints every scope selecting a retired model at its replacement. Returns
 * the model keys it rewrote, so the caller can say so in the log.
 */
export function sweepRetiredCloudModelSelections(
  storage: RetiredModelStorage,
  scopes: readonly ScopeStorageKeys[]
): string[] {
  const swept: string[] = [];

  for (const [providerId, entry] of Object.entries(RETIRED_CLOUD_MODELS)) {
    if (storage.getItem(entry.migratedKey) === "1") continue;

    for (const keys of scopes) {
      if (storage.getItem(keys.provider) !== providerId) continue;
      const model = storage.getItem(keys.model);
      const replacement = model ? entry.models[model] : undefined;
      if (!replacement) continue;
      storage.setItem(keys.model, replacement);
      swept.push(keys.model);
    }

    storage.setItem(entry.migratedKey, "1");
  }

  return swept;
}
