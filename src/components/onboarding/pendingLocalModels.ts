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
  managedIdentity?: PendingManagedModelIdentity;
}

export interface PendingManagedModelIdentity {
  accountId: string;
  workspaceId: string;
  authGeneration: number;
  configVersion: number;
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
  selection: PendingLocalModelSelection,
  managedIdentity?: PendingManagedModelIdentity
) {
  writePendingLocalModels({
    ...readPendingLocalModels(),
    [kind]: managedIdentity ? { ...selection, managedIdentity } : selection,
  });
}

function isSameManagedIdentity(
  left: PendingManagedModelIdentity,
  right: PendingManagedModelIdentity
): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.authGeneration === right.authGeneration &&
    left.configVersion === right.configVersion
  );
}

function isSamePendingLocalModelSelection(
  left: PendingLocalModelSelection,
  right: PendingLocalModelSelection
): boolean {
  if (left.provider !== right.provider || left.modelId !== right.modelId) return false;
  if (!left.managedIdentity || !right.managedIdentity) {
    return left.managedIdentity === right.managedIdentity;
  }
  return isSameManagedIdentity(left.managedIdentity, right.managedIdentity);
}

export function isPendingLocalModelSelectionCurrent(
  kind: PendingLocalModelKind,
  selection: PendingLocalModelSelection
): boolean {
  const current = readPendingLocalModels()[kind];
  return Boolean(current && isSamePendingLocalModelSelection(current, selection));
}

export function consumePendingLocalModel(
  kind: PendingLocalModelKind,
  modelId: string,
  managedIdentity?: PendingManagedModelIdentity
): PendingLocalModelSelection | null {
  const selections = readPendingLocalModels();
  const selection = selections[kind];
  if (!selection || selection.modelId !== modelId) return null;
  if (
    selection.managedIdentity &&
    (!managedIdentity || !isSameManagedIdentity(selection.managedIdentity, managedIdentity))
  ) {
    return null;
  }
  delete selections[kind];
  writePendingLocalModels(selections);
  return { provider: selection.provider, modelId: selection.modelId };
}

export function consumePendingLocalModelCompletion(
  kind: PendingLocalModelKind,
  modelId: string
): {
  selection: PendingLocalModelSelection;
  activationOwner: "coordinator" | "tray";
} | null {
  const activationOwner = getPendingLocalModelActivationOwner(kind, modelId);
  if (!activationOwner) return null;
  const pending = readPendingLocalModels()[kind];
  if (!pending) return null;
  const selection = consumePendingLocalModel(kind, modelId, pending.managedIdentity);
  if (!selection) return null;
  return {
    selection,
    activationOwner,
  };
}

export function getPendingLocalModelActivationOwner(
  kind: PendingLocalModelKind,
  modelId: string
): "coordinator" | "tray" | null {
  const pending = readPendingLocalModels()[kind];
  if (!pending || pending.modelId !== modelId) return null;
  return pending.managedIdentity ? "coordinator" : "tray";
}

export function forgetPendingLocalModel(kind: PendingLocalModelKind, modelId?: string) {
  const selections = readPendingLocalModels();
  if (modelId && selections[kind]?.modelId !== modelId) return;
  delete selections[kind];
  writePendingLocalModels(selections);
}

export function forgetPendingLocalModelSelection(
  kind: PendingLocalModelKind,
  selection: PendingLocalModelSelection
): boolean {
  const selections = readPendingLocalModels();
  const current = selections[kind];
  if (!current || !isSamePendingLocalModelSelection(current, selection)) return false;
  delete selections[kind];
  writePendingLocalModels(selections);
  return true;
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
