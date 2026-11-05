import { usesParakeetManager } from "../../helpers/localASROrganization";
import { isLocalModelAllowedByPolicy, type PolicyDecisionSnapshot } from "../../stores/policyRules";
import type {
  LocalLLMModelStatus,
  ParakeetModelResult,
  WhisperModelResult,
} from "../../types/electron";

export const PENDING_LOCAL_MODELS_KEY = "pendingLocalModelSelectionsV1";

// "dictation" only comes from an older build's picker; local setup leaves the
// optional rows still downloading at Proceed as "cleanup" and "assistant".
export type PendingLocalModelKind = "dictation" | "cleanup" | "assistant";

export interface PendingLocalModelSelection {
  provider: string;
  modelId: string;
  /** Left by local setup, whose download the tray resumes after a quit; an older build's pick isn't. */
  resumable?: boolean;
  accountId?: string | null;
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

/**
 * A row switched on at Proceed whose model is still downloading: the tray (or the
 * download itself) turns it on once the model is on disk.
 */
export function rememberPendingLocalModel(
  kind: PendingLocalModelKind,
  selection: PendingLocalModelSelection
) {
  writePendingLocalModels({ ...readPendingLocalModels(), [kind]: selection });
  localStorage.setItem("localSetupPending", "true");
}

/**
 * Hands over the selection for a finished download, or null when it can't be
 * activated. It is kept for a later try until the verdict is final: another
 * account or a settled denial drops it, while an unresolved policy leaves it in
 * place. The account is the identity, since a rotated token changes only the
 * generation. A blank account while a selection names one is unresolved too:
 * suspending the policy and a relaunch before its first fetch both blank it.
 */
export function consumePendingLocalModel(
  kind: PendingLocalModelKind,
  modelId: string,
  policy: PolicyDecisionSnapshot & { accountId?: string | null }
): PendingLocalModelSelection | null {
  const selections = readPendingLocalModels();
  const selection = selections[kind];
  if (!selection || selection.modelId !== modelId) return null;
  // A selection naming no account was a guest's: signing in moves it to the new
  // account, whose settled verdict judges it below.
  const accountChanged =
    policy.accountId != null &&
    selection.accountId != null &&
    selection.accountId !== policy.accountId;
  if (
    !accountChanged &&
    (policy.status === "loading" ||
      policy.status === "error" ||
      (selection.accountId != null && policy.accountId == null))
  )
    return null;
  delete selections[kind];
  writePendingLocalModels(selections);
  if (
    accountChanged ||
    !isLocalModelAllowedByPolicy(
      policy,
      kind === "dictation" ? "transcription" : "llm",
      selection.modelId
    )
  )
    return null;
  return selection;
}

export function forgetPendingLocalModel(kind: PendingLocalModelKind, modelId?: string) {
  const selections = readPendingLocalModels();
  if (modelId && selections[kind]?.modelId !== modelId) return;
  delete selections[kind];
  writePendingLocalModels(selections);
}

/**
 * Drops every remembered pick and the flag that lets the tray apply them, so an
 * older build's pick can't switch a row back on over the user's choice. Local
 * setup remembers its own rows again after this.
 */
export function discardPendingLocalSetup() {
  localStorage.removeItem(PENDING_LOCAL_MODELS_KEY);
  localStorage.removeItem("localSetupPending");
}

export function hasPendingLocalModels() {
  return Object.keys(readPendingLocalModels()).length > 0;
}

export function getPendingLocalModelAvailability(
  kind: PendingLocalModelKind,
  selection: PendingLocalModelSelection,
  inventory: PendingLocalModelInventory
): PendingLocalModelAvailability {
  if (kind !== "dictation") {
    if (!inventory.llm) return "unknown";
    const model = inventory.llm.find((candidate) => candidate.id === selection.modelId);
    if (model?.isDownloaded) return "downloaded";
    if (model?.isDownloading) return "downloading";
    return "missing";
  }

  const models = usesParakeetManager(selection.provider) ? inventory.parakeet : inventory.whisper;
  if (!models) return "unknown";
  const model = models.find((candidate) => candidate.model === selection.modelId);
  if (model?.downloaded) return "downloaded";
  if (model?.isDownloading) return "downloading";
  return "missing";
}
