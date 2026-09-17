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
 * That makes the sentinel, not the table, the unit of work: an id added under a
 * key a released build already writes reaches nobody who has launched it, so
 * add the id AND rotate that provider's `migratedKey`. The snapshot in
 * test/helpers/retiredCloudModels.test.js trips on either edit, which forces
 * the decision into the diff but cannot check you made it.
 */
export interface RetiredProviderModels {
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
  // All three shipped as seed entries — deepseek-v4-pro and kimi-k2-6 through
  // v1.7.6, glm-5-2 until this release — so anyone who simply took a default
  // can be on one. This key has not shipped yet, so the set could still grow.
  tinfoil: {
    migratedKey: "_retiredTinfoilModelsMigrated",
    models: {
      "glm-5-2": "glm-5-3",
      "deepseek-v4-pro": "deepseek-v4-flash",
      "kimi-k2-6": "kimi-k3",
    },
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

export interface SweptModelSelection {
  storeKey: string;
  provider: string;
  from: string;
  to: string;
}

/**
 * Repoints every scope selecting a retired model at its replacement, reporting
 * what it rewrote so the caller can log it and tell the user.
 */
export function sweepRetiredCloudModelSelections(
  storage: RetiredModelStorage,
  scopes: readonly ScopeStorageKeys[]
): SweptModelSelection[] {
  const swept: SweptModelSelection[] = [];

  for (const [providerId, entry] of Object.entries(RETIRED_CLOUD_MODELS)) {
    try {
      if (storage.getItem(entry.migratedKey) === "1") continue;

      for (const keys of scopes) {
        if (storage.getItem(keys.provider) !== providerId) continue;
        const from = storage.getItem(keys.model);
        const to = from ? entry.models[from] : undefined;
        if (!from || !to) continue;
        storage.setItem(keys.model, to);
        swept.push({ storeKey: keys.model, provider: providerId, from, to });
      }

      storage.setItem(entry.migratedKey, "1");
    } catch {
      // A storage failure leaves this provider's sentinel unset, so the next
      // launch retries; a scope repointed before the failure is then a no-op.
    }
  }

  return swept;
}
