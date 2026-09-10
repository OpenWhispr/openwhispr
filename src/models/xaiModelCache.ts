import type { CloudModelDefinition } from "./ModelRegistry";

const CACHE_KEY = "xaiLanguageModels";
const MAX_AGE_MS = 60 * 60 * 1000;

const isBrowser = typeof window !== "undefined";

export interface CachedXaiModels {
  models: CloudModelDefinition[];
  /** Epoch ms of the fetch that produced `models`, or 0 if we've never fetched. */
  fetchedAt: number;
}

const EMPTY: CachedXaiModels = { models: [], fetchedAt: 0 };

export function readCachedXaiModels(): CachedXaiModels {
  if (!isBrowser) return EMPTY;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return EMPTY;

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.models) || typeof parsed.fetchedAt !== "number") return EMPTY;
    return { models: parsed.models, fetchedAt: parsed.fetchedAt };
  } catch {
    return EMPTY;
  }
}

export function writeCachedXaiModels(models: CloudModelDefinition[]): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ models, fetchedAt: Date.now() }));
  } catch {}
}

export function isCachedListFresh(cached: CachedXaiModels): boolean {
  return cached.models.length > 0 && Date.now() - cached.fetchedAt < MAX_AGE_MS;
}
