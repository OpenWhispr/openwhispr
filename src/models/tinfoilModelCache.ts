import type { CloudModelDefinition } from "./ModelRegistry";

const CACHE_KEY = "tinfoilModels";
const MAX_AGE_MS = 60 * 60 * 1000;

const isBrowser = typeof window !== "undefined";

export interface CachedTinfoilModels {
  models: CloudModelDefinition[];
  /** Epoch ms of the fetch that produced `models`, or 0 if we've never fetched. */
  fetchedAt: number;
}

const EMPTY: CachedTinfoilModels = { models: [], fetchedAt: 0 };

export function readCachedTinfoilModels(): CachedTinfoilModels {
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

export function writeCachedTinfoilModels(models: CloudModelDefinition[]): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ models, fetchedAt: Date.now() }));
  } catch {}
}

export function isCachedListFresh(cached: CachedTinfoilModels): boolean {
  return cached.models.length > 0 && Date.now() - cached.fetchedAt < MAX_AGE_MS;
}
