import type {
  LocalLLMModelStatus,
  ParakeetModelResult,
  WhisperModelResult,
} from "../../types/electron";

export const PENDING_LOCAL_MODELS_KEY = "pendingLocalModelSelectionsV1";

export type PendingLocalModelKind = "dictation" | "assistant";

export interface PendingLocalModelSelection {
  provider: string;
  modelId: string;
}

export type PendingLocalModelSelections = Partial<
  Record<PendingLocalModelKind, PendingLocalModelSelection>
>;

export interface PendingLocalModelInventory {
  whisper?: WhisperModelResult[];
  parakeet?: ParakeetModelResult[];
  llm?: LocalLLMModelStatus[];
}

export type PendingLocalModelAvailability = "downloading" | "downloaded" | "missing" | "unknown";

export function readPendingLocalModels(): PendingLocalModelSelections {
  try {
    const value = localStorage.getItem(PENDING_LOCAL_MODELS_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as PendingLocalModelSelections;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingLocalModels(selections: PendingLocalModelSelections) {
  if (Object.keys(selections).length === 0) {
    localStorage.removeItem(PENDING_LOCAL_MODELS_KEY);
    return;
  }
  localStorage.setItem(PENDING_LOCAL_MODELS_KEY, JSON.stringify(selections));
}

export function rememberPendingLocalModel(
  kind: PendingLocalModelKind,
  selection: PendingLocalModelSelection
) {
  writePendingLocalModels({ ...readPendingLocalModels(), [kind]: selection });
}

export function consumePendingLocalModel(
  kind: PendingLocalModelKind,
  modelId: string
): PendingLocalModelSelection | null {
  const selections = readPendingLocalModels();
  const selection = selections[kind];
  if (!selection || selection.modelId !== modelId) return null;
  delete selections[kind];
  writePendingLocalModels(selections);
  return selection;
}

export function forgetPendingLocalModel(kind: PendingLocalModelKind, modelId?: string) {
  const selections = readPendingLocalModels();
  if (modelId && selections[kind]?.modelId !== modelId) return;
  delete selections[kind];
  writePendingLocalModels(selections);
}

/** Drops every remembered selection, e.g. when onboarding ends on another mode. */
export function clearPendingLocalModels() {
  localStorage.removeItem(PENDING_LOCAL_MODELS_KEY);
}

export function hasPendingLocalModels() {
  return Object.keys(readPendingLocalModels()).length > 0;
}

export function getPendingLocalModelAvailability(
  kind: PendingLocalModelKind,
  selection: PendingLocalModelSelection,
  inventory: PendingLocalModelInventory
): PendingLocalModelAvailability {
  if (kind === "assistant") {
    if (!inventory.llm) return "unknown";
    const model = inventory.llm.find((candidate) => candidate.id === selection.modelId);
    if (model?.isDownloaded) return "downloaded";
    if (model?.isDownloading) return "downloading";
    return "missing";
  }

  const models = selection.provider === "nvidia" ? inventory.parakeet : inventory.whisper;
  if (!models) return "unknown";
  const model = models.find((candidate) => candidate.model === selection.modelId);
  if (model?.downloaded) return "downloaded";
  if (model?.isDownloading) return "downloading";
  return "missing";
}
