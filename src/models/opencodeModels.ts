import {
  applyOpencodeModels,
  getOpencodeCatalogModels,
  type CloudModelDefinition,
} from "./ModelRegistry";
import { getOpencodeDefaultModelId } from "./cloudModelCatalog";
import { pickProviderDefaultModel } from "./providerDefaultModel";
import {
  isCachedOpencodeListFresh,
  readCachedOpencodeModels,
  writeCachedOpencodeModels,
} from "./opencodeModelCache";
import { INFERENCE_SCOPES, usesCloudModelCatalog } from "../config/inferenceScopes";

import { getSettings, setStringSetting } from "../stores/settingsStore";
import { recordRetiredModelSwitch } from "../stores/retiredModelSwitchStore";

export type OpencodeCatalogProviderId = "opencode-go" | "opencode-zen";

const inFlight = new Map<OpencodeCatalogProviderId, Promise<CloudModelDefinition[]>>();

/**
 * Moves any scope still pointing at a model OpenCode no longer lists onto the
 * product's default. Only called after a successful fetch, so a missing model
 * really is gone.
 */
function reconcileSelectedModels(
  providerId: OpencodeCatalogProviderId,
  previous: CloudModelDefinition[],
  models: CloudModelDefinition[]
): void {
  const available = new Set(models.map((model) => model.id));
  const settings = getSettings() as unknown as Record<string, unknown>;
  const replacement = pickProviderDefaultModel(models, getOpencodeDefaultModelId(providerId));
  if (!replacement) return;
  const announced = new Set<string>();

  for (const scope of Object.values(INFERENCE_SCOPES)) {
    const { mode, provider, model } = scope.storeKeys;
    if (!usesCloudModelCatalog(settings[mode])) continue;
    if (settings[provider] !== providerId) continue;

    const selected = settings[model];
    if (typeof selected !== "string" || !selected || available.has(selected)) continue;

    setStringSetting(model, replacement.id);
    // Several scopes can share a dropped model; say so once.
    if (announced.has(selected)) continue;
    announced.add(selected);
    recordRetiredModelSwitch({
      provider: providerId,
      from: previous.find((m) => m.id === selected)?.name ?? selected,
      to: replacement.name,
    });
  }
}

async function fetchAndApply(
  providerId: OpencodeCatalogProviderId
): Promise<CloudModelDefinition[]> {
  const fetchModels = window.electronAPI?.getOpencodeModels;
  if (!fetchModels) {
    throw new Error("OpenCode model list is unavailable");
  }

  const models = await fetchModels(providerId);
  const previous = getOpencodeCatalogModels(providerId);
  applyOpencodeModels(providerId, models);
  writeCachedOpencodeModels(providerId, models);
  reconcileSelectedModels(providerId, previous, models);
  return models;
}

/** Whether refreshOpencodeModels would hit the network rather than short-circuit. */
export function isOpencodeListFresh(providerId: OpencodeCatalogProviderId): boolean {
  return isCachedOpencodeListFresh(readCachedOpencodeModels(providerId));
}

/**
 * Pulls a product's live model list into the registry, at most once an hour.
 * Rejects when OpenCode can't be reached, leaving the registry as it was.
 */
export function refreshOpencodeModels(
  providerId: OpencodeCatalogProviderId
): Promise<CloudModelDefinition[]> {
  const cached = readCachedOpencodeModels(providerId);
  if (isCachedOpencodeListFresh(cached)) {
    // Another window may have fetched this; make sure our registry has it too.
    applyOpencodeModels(providerId, cached.models);
    return Promise.resolve(cached.models);
  }

  let pending = inFlight.get(providerId);
  if (!pending) {
    pending = fetchAndApply(providerId).finally(() => {
      inFlight.delete(providerId);
    });
    inFlight.set(providerId, pending);
  }
  return pending;
}
