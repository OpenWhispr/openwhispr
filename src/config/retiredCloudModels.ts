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
 * Each provider's startup remap is one-shot, keyed by its own sentinel.
 * Tinfoil selections restored later are also normalized at request dispatch.
 *
 * That makes the sentinel, not the table, the unit of work: an id added under a
 * key a released build already writes reaches nobody who has launched it, so
 * add the id AND rotate that provider's `migratedKey`. The snapshot in
 * test/helpers/retiredCloudModels.test.js trips on either edit, which forces
 * the decision into the diff but cannot check you made it.
 */
export { RETIRED_CLOUD_MODELS } from "./retiredCloudModelPolicy.js";
import { RETIRED_CLOUD_MODELS } from "./retiredCloudModelPolicy.js";

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
