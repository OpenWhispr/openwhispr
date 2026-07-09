import type { CloudModelDefinition } from "./ModelRegistry";

const CACHE_KEY = "tinfoilModels";
const MAX_AGE_MS = 60 * 60 * 1000;

export interface CachedTinfoilModels {
  models: CloudModelDefinition[];
  /** Epoch ms of the fetch that produced `models`, or 0 if we've never fetched. */
  fetchedAt: number;
}

const EMPTY: CachedTinfoilModels = { models: [], fetchedAt: 0 };

/**
 * The last list Tinfoil gave us, and when. Persisting both means a launch still
 * knows every model the user has seen, and doesn't refetch a list it pulled a
 * minute before the app restarted.
 */
export function readCachedTinfoilModels(): CachedTinfoilModels {
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

export function writeCachedTinfoilModels(models: CloudModelDefinition[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ models, fetchedAt: Date.now() }));
  } catch {
    // Cache is best-effort; a failed write just means a refetch next launch.
  }
}

export function isCachedListFresh(cached: CachedTinfoilModels): boolean {
  return cached.models.length > 0 && Date.now() - cached.fetchedAt < MAX_AGE_MS;
}
