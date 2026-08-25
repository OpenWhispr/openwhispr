import type {
  LocalLLMModelStatus,
  ParakeetModelResult,
  WhisperModelResult,
} from "../../types/electron";
import type { ManagedLocalModelIdentity } from "./managedLocalModels";

export const PENDING_LOCAL_MODELS_KEY = "pendingLocalModelSelectionsV1";

export type PendingLocalModelKind = "dictation" | "assistant";

export interface PendingLocalModelSelection {
  provider: string;
  modelId: string;
}

export interface ManagedPendingLocalModelSelection
  extends PendingLocalModelSelection, ManagedLocalModelIdentity {
  transferState: "downloading" | "missing";
  errorCode?: "DOWNLOAD_CANCELLED" | "DOWNLOAD_FAILED";
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

function isExactManagedPendingSelection(
  selection: PendingLocalModelSelection | undefined,
  expected: Omit<ManagedPendingLocalModelSelection, "transferState">
): selection is ManagedPendingLocalModelSelection {
  if (!selection) return false;
  const candidate = selection as Partial<ManagedPendingLocalModelSelection>;
  return (
    candidate.provider === expected.provider &&
    candidate.modelId === expected.modelId &&
    candidate.accountId === expected.accountId &&
    candidate.workspaceId === expected.workspaceId &&
    candidate.authGeneration === expected.authGeneration &&
    candidate.configGeneration === expected.configGeneration
  );
}

/** Managed downloads use the established pending-selection key with an exact session fence. */
export function rememberManagedPendingLocalModel(
  kind: PendingLocalModelKind,
  selection: ManagedPendingLocalModelSelection
): void {
  rememberPendingLocalModel(kind, selection);
}

export function consumeManagedPendingLocalModel(
  kind: PendingLocalModelKind,
  expected: ManagedPendingLocalModelSelection
): ManagedPendingLocalModelSelection | null {
  const selection = readManagedPendingLocalModel(kind, expected);
  if (!selection) return null;
  const selections = readPendingLocalModels();
  delete selections[kind];
  writePendingLocalModels(selections);
  return selection;
}

export function readManagedPendingLocalModel(
  kind: PendingLocalModelKind,
  expected: Omit<ManagedPendingLocalModelSelection, "transferState">
): ManagedPendingLocalModelSelection | null {
  const selection = readPendingLocalModels()[kind];
  return isExactManagedPendingSelection(selection, expected) ? selection : null;
}

export function markManagedPendingLocalModelCancelled(
  kind: PendingLocalModelKind,
  selection: PendingLocalModelSelection | undefined
): boolean {
  if (!selection || !("accountId" in selection)) return false;
  rememberManagedPendingLocalModel(kind, {
    ...(selection as ManagedPendingLocalModelSelection),
    transferState: "missing",
    errorCode: "DOWNLOAD_CANCELLED",
  });
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
