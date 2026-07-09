import { applyTinfoilModels, getTinfoilModels, type CloudModelDefinition } from "./ModelRegistry";
import {
  isCachedListFresh,
  readCachedTinfoilModels,
  writeCachedTinfoilModels,
} from "./tinfoilModelCache";
import { INFERENCE_SCOPES } from "../config/inferenceScopes";
import { getSettings, setStringSetting } from "../stores/settingsStore";
import { recordTinfoilModelSwitch } from "../stores/tinfoilModelSwitchStore";

/** A chat model as reported by Tinfoil's /v1/models, narrowed by the main process. */
export interface TinfoilCatalogModel {
  id: string;
  name: string;
  description: string;
  supportsThinking: boolean;
}

/**
 * Curated, translated descriptions keyed by model id. The endpoint only returns
 * English copy, so prefer these where we have them and fall back to the
 * endpoint's own description for models we haven't written one for.
 */
const DESCRIPTION_KEYS: Record<string, string> = {
  "deepseek-v4-pro": "models.descriptions.cloud.tinfoil_deepseek_v4_pro",
  "glm-5-2": "models.descriptions.cloud.tinfoil_glm_5_2",
  "kimi-k2-6": "models.descriptions.cloud.tinfoil_kimi_k2_6",
  "gemma4-31b": "models.descriptions.cloud.tinfoil_gemma4_31b",
  "gpt-oss-120b": "models.descriptions.cloud.tinfoil_gpt_oss_120b",
  "llama3-3-70b": "models.descriptions.cloud.tinfoil_llama3_3_70b",
};

/**
 * Turns Tinfoil's live list into registry entries. The endpoint is the source
 * of truth for which models exist and what they do, so models it doesn't list
 * drop out and models we've never heard of appear. Only the description is
 * ours: every Tinfoil model takes max_tokens and supports temperature.
 */
export function mergeTinfoilModels(catalog: TinfoilCatalogModel[]): CloudModelDefinition[] {
  return catalog.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    descriptionKey: DESCRIPTION_KEYS[model.id],
    supportsThinking: model.supportsThinking,
    tokenParam: "max_tokens",
    supportsTemperature: true,
  }));
}

const DEFAULT_MODEL_ID = "glm-5-2";

/**
 * The model to select when the user hasn't chosen one, or when the one they
 * chose is gone. Tinfoil's list order isn't a preference and can change without
 * an app release, so don't let it decide this.
 */
export function pickDefaultTinfoilModel(
  models: CloudModelDefinition[]
): CloudModelDefinition | undefined {
  return models.find((model) => model.id === DEFAULT_MODEL_ID) ?? models[0];
}

/**
 * Moves any scope still pointing at a model Tinfoil has retired onto one it
 * still serves — otherwise the next request is a 404 the user can't diagnose.
 * Only ever called after a successful fetch, so a missing model really is gone.
 */
function reconcileSelectedModels(
  previous: CloudModelDefinition[],
  models: CloudModelDefinition[]
): void {
  const available = new Set(models.map((model) => model.id));
  const settings = getSettings() as unknown as Record<string, unknown>;
  const replacement = pickDefaultTinfoilModel(models);
  if (!replacement) return;
  const announced = new Set<string>();

  for (const scope of Object.values(INFERENCE_SCOPES)) {
    const { provider, model } = scope.storeKeys;
    if (settings[provider] !== "tinfoil") continue;

    const selected = settings[model];
    if (typeof selected !== "string" || !selected || available.has(selected)) continue;

    setStringSetting(model, replacement.id);
    // Several scopes can share a retired model; say so once.
    if (announced.has(selected)) continue;
    announced.add(selected);
    recordTinfoilModelSwitch({
      from: previous.find((m) => m.id === selected)?.name ?? selected,
      to: replacement.name,
    });
  }
}

let inFlight: Promise<CloudModelDefinition[]> | null = null;

async function fetchAndApply(): Promise<CloudModelDefinition[]> {
  const fetchModels = window.electronAPI?.getTinfoilChatModels;
  if (!fetchModels) {
    throw new Error("Tinfoil model list is unavailable");
  }

  const models = mergeTinfoilModels(await fetchModels());
  // An empty list would mean Tinfoil serves no chat models at all. Far more
  // likely something upstream broke, so keep what we already have.
  if (models.length === 0) {
    throw new Error("Tinfoil returned no chat models");
  }

  const previous = getTinfoilModels();
  applyTinfoilModels(models);
  writeCachedTinfoilModels(models);
  reconcileSelectedModels(previous, models);
  return models;
}

/**
 * Pulls Tinfoil's model list into the registry, at most once an hour. Cheap to
 * call before every request: a list we fetched recently short-circuits without
 * touching the network, and the timestamp is persisted so a restart doesn't
 * refetch a list we pulled a minute ago. Rejects when Tinfoil can't be reached,
 * leaving the registry as it was — an unreachable endpoint says nothing about
 * which models still exist.
 */
/** Whether refreshTinfoilModels would hit the network rather than short-circuit. */
export function isTinfoilListFresh(): boolean {
  return isCachedListFresh(readCachedTinfoilModels());
}

export function refreshTinfoilModels(): Promise<CloudModelDefinition[]> {
  const cached = readCachedTinfoilModels();
  if (isCachedListFresh(cached)) {
    // Another window may have fetched this; make sure our registry has it too.
    applyTinfoilModels(cached.models);
    return Promise.resolve(cached.models);
  }

  if (!inFlight) {
    inFlight = fetchAndApply().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
