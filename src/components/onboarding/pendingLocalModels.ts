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
  /** Background downloads of it that failed; a launch stops retrying on its own at the limit. */
  failedAttempts?: number;
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

/**
 * Every local model main knows of, read one way for the setup step and the tray,
 * so they never disagree on what is on disk. A family that can't be read is left out.
 */
export async function readLocalModelInventory(): Promise<PendingLocalModelInventory> {
  const api = window.electronAPI;
  const [whisper, parakeet, llm] = await Promise.all([
    api?.listWhisperModels?.().catch(() => undefined),
    api?.listParakeetModels?.().catch(() => undefined),
    api?.modelGetAll?.().catch(() => undefined),
  ]);
  return { whisper: whisper?.models, parakeet: parakeet?.models, llm };
}

export type PendingLocalModelVerdict = "unresolved" | "allowed" | "denied";

// A launch retries a failed download by itself this many times; after that the tray
// shows the failure and waits for the user's Retry.
export const MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS = 3;

export const PENDING_GRAPHICS_PACK_KEY = "pendingLocalGraphicsPackFailures";

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

function writePendingLocalModels(selections: PendingLocalModelSelections): void {
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
): void {
  writePendingLocalModels({ ...readPendingLocalModels(), [kind]: selection });
  localStorage.setItem("localSetupPending", "true");
}

/**
 * Whether a pending selection may still run. Another account or a settled denial
 * is final, while an unresolved policy can still go either way. The account is the
 * identity, since a rotated token changes only the generation. A blank account
 * while a selection names one is unresolved too: suspending the policy and a
 * relaunch before its first fetch both blank it.
 */
export function judgePendingLocalModel(
  kind: PendingLocalModelKind,
  selection: PendingLocalModelSelection,
  policy: PolicyDecisionSnapshot & { accountId?: string | null }
): PendingLocalModelVerdict {
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
    return "unresolved";
  return !accountChanged &&
    isLocalModelAllowedByPolicy(
      policy,
      kind === "dictation" ? "transcription" : "llm",
      selection.modelId
    )
    ? "allowed"
    : "denied";
}

/**
 * Hands over the selection for a finished download, or null when it can't be
 * activated. It is kept for a later try while the policy is unresolved, and
 * dropped once the verdict is a denial.
 */
export function consumePendingLocalModel(
  kind: PendingLocalModelKind,
  modelId: string,
  policy: PolicyDecisionSnapshot & { accountId?: string | null }
): PendingLocalModelSelection | null {
  const selections = readPendingLocalModels();
  const selection = selections[kind];
  if (!selection || selection.modelId !== modelId) return null;
  const verdict = judgePendingLocalModel(kind, selection, policy);
  if (verdict === "unresolved") return null;
  delete selections[kind];
  writePendingLocalModels(selections);
  return verdict === "allowed" ? selection : null;
}

export function forgetPendingLocalModel(kind: PendingLocalModelKind, modelId?: string): void {
  const selections = readPendingLocalModels();
  if (modelId && selections[kind]?.modelId !== modelId) return;
  delete selections[kind];
  writePendingLocalModels(selections);
}

/** A download stopped by hand (Settings' cancel): nothing should resume or activate it. */
export function forgetPendingLocalModelById(modelId: string): void {
  for (const kind of ["dictation", "cleanup", "assistant"] as const) {
    forgetPendingLocalModel(kind, modelId);
  }
}

/** Counts a failed background download toward the limit on automatic retries. */
export function recordPendingLocalModelFailure(modelId: string): void {
  const selections = readPendingLocalModels();
  for (const selection of Object.values(selections)) {
    if (selection?.modelId === modelId) {
      selection.failedAttempts = (selection.failedAttempts ?? 0) + 1;
    }
  }
  writePendingLocalModels(selections);
}

/** The user pressed Retry: the limit on automatic retries starts over. */
export function clearPendingLocalModelFailures(modelId: string): void {
  const selections = readPendingLocalModels();
  for (const selection of Object.values(selections)) {
    if (selection?.modelId === modelId) delete selection.failedAttempts;
  }
  writePendingLocalModels(selections);
}

export function isPendingLocalModel(modelId: string): boolean {
  return Object.values(readPendingLocalModels()).some(
    (selection) => selection?.modelId === modelId
  );
}

/** The graphics pack was still on its way at Proceed: the tray fetches it after a quit. */
export function rememberPendingGraphicsPack(): void {
  localStorage.setItem(PENDING_GRAPHICS_PACK_KEY, "0");
  localStorage.setItem("localSetupPending", "true");
}

export function hasPendingGraphicsPack(): boolean {
  return localStorage.getItem(PENDING_GRAPHICS_PACK_KEY) !== null;
}

export function forgetPendingGraphicsPack(): void {
  localStorage.removeItem(PENDING_GRAPHICS_PACK_KEY);
}

/** A pack that keeps failing is given up on: nothing on screen names it, and text models still run. */
export function recordPendingGraphicsPackFailure(): void {
  const failures = Number(localStorage.getItem(PENDING_GRAPHICS_PACK_KEY)) + 1;
  if (failures >= MAX_AUTOMATIC_DOWNLOAD_ATTEMPTS) forgetPendingGraphicsPack();
  else localStorage.setItem(PENDING_GRAPHICS_PACK_KEY, String(failures));
}

/**
 * Drops every remembered pick and the flag that lets the tray apply them, so an
 * older build's pick can't switch a row back on over the user's choice. Local
 * setup remembers its own rows again after this.
 */
export function discardPendingLocalSetup(): void {
  localStorage.removeItem(PENDING_LOCAL_MODELS_KEY);
  forgetPendingGraphicsPack();
  localStorage.removeItem("localSetupPending");
}

export function hasPendingLocalModels(): boolean {
  return Object.keys(readPendingLocalModels()).length > 0 || hasPendingGraphicsPack();
}

/**
 * True while the assistant row's model is on its way: it is pending and a text model
 * is downloading now, its own or the one queued ahead of it. A pending model whose
 * download failed reads as false, so chat doesn't promise it is coming.
 */
export async function isPendingAssistantModelDownloading(): Promise<boolean> {
  if (!readPendingLocalModels().assistant) return false;
  const active = await window.electronAPI?.modelGetActiveDownloads?.().catch(() => undefined);
  return !!active?.some((download) => download.modelType === "llm");
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
