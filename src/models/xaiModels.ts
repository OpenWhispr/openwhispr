import {
  applyXaiModels,
  getCloudProviderDefaultModelId,
  getXaiModels,
  type CloudModelDefinition,
} from "./ModelRegistry";
import { pickProviderDefaultModel } from "./providerDefaultModel";
import { isCachedListFresh, readCachedXaiModels, writeCachedXaiModels } from "./xaiModelCache";
import { INFERENCE_SCOPES } from "../config/inferenceScopes";
import { getSettings, setStringSetting } from "../stores/settingsStore";
import logger from "../utils/logger";

export interface XaiCatalogModel {
  id: string;
  name: string;
  description: string;
  supportsVision: boolean;
  supportsThinking: boolean;
}

export const DESCRIPTION_KEYS: Record<string, string> = {
  "grok-4.5": "models.descriptions.cloud.xai_grok_4_5",
  "grok-4-fast": "models.descriptions.cloud.xai_grok_4_fast",
  "grok-4.3": "models.descriptions.cloud.xai_grok_4_3",
};

function toCloudModels(catalog: XaiCatalogModel[]): CloudModelDefinition[] {
  return catalog.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    descriptionKey: DESCRIPTION_KEYS[model.id],
    supportsThinking: model.supportsThinking,
    supportsVision: model.supportsVision,
    tokenParam: "max_tokens",
    supportsTemperature: true,
  }));
}

export function pickDefaultXaiModel(
  models: CloudModelDefinition[]
): CloudModelDefinition | undefined {
  return pickProviderDefaultModel(models, getCloudProviderDefaultModelId("xai"));
}

function reconcileSelectedModels(
  previous: CloudModelDefinition[],
  models: CloudModelDefinition[]
): void {
  const available = new Set(models.map((model) => model.id));
  const settings = getSettings() as unknown as Record<string, unknown>;
  const replacement = pickDefaultXaiModel(models);
  if (!replacement) return;

  for (const scope of Object.values(INFERENCE_SCOPES)) {
    const { provider, model } = scope.storeKeys;
    if (settings[provider] !== "xai") continue;

    const selected = settings[model];
    if (typeof selected !== "string" || !selected || available.has(selected)) continue;

    setStringSetting(model, replacement.id);
    logger.info(
      "xAI retired a selected model; switched to default",
      {
        from: previous.find((item) => item.id === selected)?.name ?? selected,
        to: replacement.name,
      },
      "models"
    );
  }
}

let inFlight: Promise<CloudModelDefinition[]> | null = null;

async function fetchAndApply(): Promise<CloudModelDefinition[]> {
  const fetchModels = window.electronAPI?.getXaiLanguageModels;
  if (!fetchModels) {
    throw new Error("xAI model list is unavailable");
  }

  const models = toCloudModels(await fetchModels());
  if (models.length === 0) {
    throw new Error("xAI returned no language models");
  }

  const previous = getXaiModels();
  applyXaiModels(models);
  writeCachedXaiModels(models);
  reconcileSelectedModels(previous, models);
  return models;
}

export function isXaiListFresh(): boolean {
  return isCachedListFresh(readCachedXaiModels());
}

/**
 * Pulls xAI's language-model list into the registry, at most once an hour.
 * A recent cache short-circuits. Rejects when xAI can't be reached, leaving
 * the bundled fallback in place.
 */
export function refreshXaiModels(): Promise<CloudModelDefinition[]> {
  const cached = readCachedXaiModels();
  if (isCachedListFresh(cached)) {
    applyXaiModels(cached.models);
    return Promise.resolve(cached.models);
  }

  if (!inFlight) {
    inFlight = fetchAndApply().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
