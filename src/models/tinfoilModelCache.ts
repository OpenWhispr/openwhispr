import type { CloudModelDefinition } from "./ModelRegistry";

import { isSelectableTinfoilModel } from "../config/retiredCloudModelPolicy.js";
import modelRegistryData from "./modelRegistryData.json";

// Capture the seed before ModelRegistry hydrates its mutable provider list.
const seed = modelRegistryData.cloudProviders.find((provider) => provider.id === "tinfoil");
const defaultModel = seed?.models.find((model) => model.id === seed.defaultModel);

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
    const models = parsed.models.filter(
      (model) => typeof model?.id === "string" && isSelectableTinfoilModel(model)
    );
    if (models.length !== parsed.models.length) {
      // An old cache may omit the explicit replacement. Keep it available offline.
      if (defaultModel && !models.some((model) => model.id === defaultModel.id)) {
        models.push(defaultModel);
      }
      writeCachedTinfoilModels(models, parsed.fetchedAt);
    }
    return { models, fetchedAt: parsed.fetchedAt };
  } catch {
    return EMPTY;
  }
}

export function writeCachedTinfoilModels(
  models: CloudModelDefinition[],
  fetchedAt = Date.now()
): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ models: models.filter(isSelectableTinfoilModel), fetchedAt })
    );
  } catch {}
}

export function isCachedListFresh(cached: CachedTinfoilModels): boolean {
  return cached.models.length > 0 && Date.now() - cached.fetchedAt < MAX_AGE_MS;
}
