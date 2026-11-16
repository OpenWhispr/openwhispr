import type { CloudModelDefinition } from "./ModelRegistry";
import { isSelectableOpencodeModelId } from "../config/opencodeModelPolicy.js";

const MAX_AGE_MS = 60 * 60 * 1000;

const isBrowser = typeof window !== "undefined";

export interface CachedOpencodeModels {
  models: CloudModelDefinition[];
  /** Epoch ms of the fetch that produced `models`, or 0 if we've never fetched. */
  fetchedAt: number;
}

const EMPTY: CachedOpencodeModels = { models: [], fetchedAt: 0 };

function cacheKey(providerId: string): string {
  return `opencodeModels:${providerId}`;
}

export function readCachedOpencodeModels(providerId: string): CachedOpencodeModels {
  if (!isBrowser) return EMPTY;
  try {
    const raw = localStorage.getItem(cacheKey(providerId));
    if (!raw) return EMPTY;

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.models) || typeof parsed.fetchedAt !== "number") return EMPTY;
    // A cache from an older build may still hold an id this build has dropped,
    // or an entry without a display name, which the picker would render as a
    // blank row. Dropping either lets the next refresh heal the list.
    const models = parsed.models.filter(
      (model: CloudModelDefinition) =>
        typeof model?.id === "string" &&
        typeof model?.name === "string" &&
        model.name.trim() !== "" &&
        isSelectableOpencodeModelId(model.id)
    );
    return { models, fetchedAt: parsed.fetchedAt };
  } catch {
    return EMPTY;
  }
}

export function writeCachedOpencodeModels(
  providerId: string,
  models: CloudModelDefinition[],
  fetchedAt = Date.now()
): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(cacheKey(providerId), JSON.stringify({ models, fetchedAt }));
  } catch {}
}

export function isCachedOpencodeListFresh(cached: CachedOpencodeModels): boolean {
  return cached.models.length > 0 && Date.now() - cached.fetchedAt < MAX_AGE_MS;
}
