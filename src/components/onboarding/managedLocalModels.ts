import type {
  ManagedEnterpriseLocalModelSelection,
  ManagedEnterpriseLocalModels,
} from "../../types/enterpriseIdentity";
import {
  readPendingLocalModels,
  type PendingLocalModelKind,
  type PendingManagedModelIdentity,
} from "./pendingLocalModels.ts";

export const MANAGED_LOCAL_MODEL_BINDINGS_KEY = "enterpriseManagedLocalModelBindingsV1";
export const MANAGED_LOCAL_MODEL_RECONCILIATION_LOCK =
  "openwhispr-managed-local-model-reconciliation";

export const MANAGED_LOCAL_MODEL_ERROR_CODES = {
  policyTranscription: "MANAGED_LOCAL_MODEL_POLICY_TRANSCRIPTION",
  policyReasoning: "MANAGED_LOCAL_MODEL_POLICY_REASONING",
  incompatibleTranscription: "MANAGED_LOCAL_MODEL_INCOMPATIBLE_TRANSCRIPTION",
  incompatibleReasoning: "MANAGED_LOCAL_MODEL_INCOMPATIBLE_REASONING",
  downloadCancelled: "MANAGED_LOCAL_MODEL_DOWNLOAD_CANCELLED",
} as const;

export function translateManagedLocalModelError(
  error: string,
  translate: (key: string) => string
): string {
  switch (error) {
    case MANAGED_LOCAL_MODEL_ERROR_CODES.policyTranscription:
      return translate("managedLocalModels.errors.policyTranscription");
    case MANAGED_LOCAL_MODEL_ERROR_CODES.policyReasoning:
      return translate("managedLocalModels.errors.policyReasoning");
    case MANAGED_LOCAL_MODEL_ERROR_CODES.incompatibleTranscription:
      return translate("managedLocalModels.errors.incompatibleTranscription");
    case MANAGED_LOCAL_MODEL_ERROR_CODES.incompatibleReasoning:
      return translate("managedLocalModels.errors.incompatibleReasoning");
    case MANAGED_LOCAL_MODEL_ERROR_CODES.downloadCancelled:
      return translate("managedLocalModels.errors.downloadCancelled");
    case "MANAGED_CONFIG_INVALID":
      return translate("managedLocalModels.onboarding.configInvalid");
    case "MANAGED_ENTERPRISE_UNSUPPORTED":
      return translate("managedLocalModels.onboarding.requiresNewerVersion");
    case "AUTH_EXPIRED":
    case "AUTH_CONTEXT_CHANGED":
    case "AUTH_CONTEXT_UNVALIDATED":
      return translate("managedLocalModels.onboarding.authExpired");
    case "ENTERPRISE_REQUIRED":
    case "MANAGED_WORKSPACE_REQUIRED":
      return translate("managedLocalModels.onboarding.enterpriseRequired");
    case "SSO_REQUIRED":
      return translate("managedLocalModels.onboarding.ssoRequired");
    case "DIRECTORY_ASSIGNMENT_REQUIRED":
    case "PROVIDER_NOT_ALLOWED":
    case "PROVIDER_NOT_CONFIGURED":
    case "POLICY_UNRESOLVABLE":
      return translate("managedLocalModels.onboarding.administratorRequired");
    case "MANAGED_CONFIG_UNAVAILABLE":
    case "MANAGED_CONFIG_FAILED":
      return translate("managedLocalModels.onboarding.configUnavailableFallback");
    default:
      return error;
  }
}

export type ManagedLocalModelCategory = "transcription" | "reasoning";

export interface ManagedLocalModelBinding {
  configVersion: number;
  transcription: ManagedEnterpriseLocalModelSelection | null;
  reasoning: ManagedEnterpriseLocalModelSelection | null;
  error: string | null;
  categoryErrors?: Partial<Record<ManagedLocalModelCategory, string>>;
  retryGeneration?: number;
}

interface ManagedLocalModeOption {
  id: string;
  disabled?: boolean;
}

export function constrainManagedLocalModeOptions<T extends ManagedLocalModeOption>(
  options: T[],
  managed: boolean
): T[] {
  if (!managed) return options;
  return options.map((option) => ({
    ...option,
    disabled: option.disabled || option.id !== "local",
  }));
}

export function canSelectManagedLocalMode(managed: boolean, mode: string): boolean {
  return !managed || mode === "local";
}

export function applyManagedLocalModeChange(
  managed: boolean,
  mode: string,
  apply: () => void
): boolean {
  if (!canSelectManagedLocalMode(managed, mode)) return false;
  apply();
  return true;
}

export function applyManagedLocalModelSelectionWhenAllowed(
  policyAllowsLocal: boolean,
  apply: () => void,
  onBlocked: () => void
): boolean {
  if (!policyAllowsLocal) {
    onBlocked();
    return false;
  }
  apply();
  return true;
}

export function routeManagedLocalModelSetupChoice(
  ownsDownloads: boolean,
  installed: boolean,
  actions: { persist: () => void; apply: () => void; download: () => void }
): "delegated" | "applied" | "downloaded" {
  actions.persist();
  if (!ownsDownloads) return "delegated";
  if (installed) {
    actions.apply();
    return "applied";
  }
  actions.download();
  return "downloaded";
}

export function canChooseManagedLocalModel(
  compatible: boolean,
  policyAllowsLocal: boolean
): boolean {
  return compatible && policyAllowsLocal;
}

export function canInitialSetupApplyManagedLocalModel(
  ownsDownloads: boolean,
  onboardingCompleted: boolean
): boolean {
  return ownsDownloads && !onboardingCompleted;
}

interface ManagedLocalSetupReadiness {
  identityKey: string;
  ready: boolean;
}

export function resolveManagedLocalSetupReadiness(
  readiness: ManagedLocalSetupReadiness,
  identityKey: string
): boolean {
  return readiness.identityKey === identityKey && readiness.ready;
}

export function updateManagedLocalSetupReadiness(
  current: ManagedLocalSetupReadiness,
  identityKey: string,
  ready: boolean
): ManagedLocalSetupReadiness {
  if (current.identityKey === identityKey && current.ready === ready) return current;
  return { identityKey, ready };
}

export function isManagedLocalModelDownloadActive(
  hookReportsDownloading: boolean,
  inventoryReportsDownloading: boolean
): boolean {
  return hookReportsDownloading || inventoryReportsDownloading;
}

export interface ManagedLocalModelDownloadAttempt {
  identity: PendingManagedModelIdentity;
  category: ManagedLocalModelCategory;
  selection: ManagedEnterpriseLocalModelSelection;
}

export function recordManagedLocalModelDownloadError(
  attempt: ManagedLocalModelDownloadAttempt,
  error: string
): boolean {
  const { identity, category, selection } = attempt;
  const pendingKind = category === "reasoning" ? "assistant" : "dictation";
  const pending = readPendingLocalModels()[pendingKind];
  const pendingIdentity = pending?.managedIdentity;
  if (
    !pending ||
    pending.provider !== selection.provider ||
    pending.modelId !== selection.modelId ||
    !pendingIdentity ||
    pendingIdentity.accountId !== identity.accountId ||
    pendingIdentity.workspaceId !== identity.workspaceId ||
    pendingIdentity.authGeneration !== identity.authGeneration ||
    pendingIdentity.configVersion !== identity.configVersion
  ) {
    return false;
  }
  const binding = readManagedLocalModelBinding(identity.accountId, identity.workspaceId);
  const boundSelection = binding?.[category];
  if (
    binding?.configVersion !== identity.configVersion ||
    boundSelection?.provider !== selection.provider ||
    boundSelection.modelId !== selection.modelId
  ) {
    return false;
  }
  setManagedLocalModelCategoryError(
    identity.accountId,
    identity.workspaceId,
    identity.configVersion,
    category,
    error
  );
  return true;
}

export function recordPendingManagedLocalModelError(
  kind: PendingLocalModelKind,
  modelId: string,
  error: string
): boolean {
  const pending = readPendingLocalModels()[kind];
  if (!pending?.managedIdentity || pending.modelId !== modelId) return false;
  return recordManagedLocalModelDownloadError(
    {
      identity: pending.managedIdentity,
      category: kind === "dictation" ? "transcription" : "reasoning",
      selection: { provider: pending.provider, modelId: pending.modelId },
    },
    error
  );
}

export function isManagedLocalModelBindingSelectionCurrent(
  binding: ManagedLocalModelBinding | null,
  configVersion: number,
  category: ManagedLocalModelCategory,
  selection: ManagedEnterpriseLocalModelSelection
): boolean {
  const current = binding?.[category];
  return Boolean(
    binding?.configVersion === configVersion &&
    current?.provider === selection.provider &&
    current.modelId === selection.modelId
  );
}

export function canApplyPendingCloudMigration(
  enterpriseStatus: "idle" | "loading" | "ready" | "error",
  failClosed: boolean,
  managed: boolean,
  workspaceIdentityResolved: boolean,
  enterpriseIdentityExpected: boolean
): boolean {
  if (
    !workspaceIdentityResolved ||
    failClosed ||
    !canSelectManagedLocalMode(managed, "openwhispr")
  ) {
    return false;
  }
  if (!enterpriseIdentityExpected) return enterpriseStatus === "idle";
  return enterpriseStatus === "ready" || enterpriseStatus === "error";
}

export async function runWithManagedLocalModelReconciliationLock(
  reconcile: () => Promise<void>
): Promise<boolean> {
  if (!navigator.locks) {
    await reconcile();
    return true;
  }
  await navigator.locks.request(MANAGED_LOCAL_MODEL_RECONCILIATION_LOCK, async () => {
    await reconcile();
  });
  return true;
}

export function beginManagedLocalModelReplacement(
  activeReplacements: Set<string>,
  key: string
): boolean {
  if (activeReplacements.has(key)) return false;
  activeReplacements.add(key);
  return true;
}

export function finishManagedLocalModelReplacement(
  activeReplacements: Set<string>,
  key: string
): void {
  activeReplacements.delete(key);
}

export function canAutomaticallyStartManagedLocalModelReplacement(
  needsReplacement: boolean,
  categoryError: string | undefined
): boolean {
  return needsReplacement && !categoryError;
}

export function createManagedLocalModelRetryBinding(
  binding: ManagedLocalModelBinding
): ManagedLocalModelBinding {
  return {
    ...binding,
    error: null,
    categoryErrors: {},
    retryGeneration: (binding.retryGeneration ?? 0) + 1,
  };
}

type ManagedLocalModelBindings = Record<string, ManagedLocalModelBinding>;

function bindingKey(accountId: string, workspaceId: string): string {
  return `${accountId}:${workspaceId}`;
}

function readBindings(): ManagedLocalModelBindings {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(MANAGED_LOCAL_MODEL_BINDINGS_KEY) ?? "{}"
    ) as ManagedLocalModelBindings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readManagedLocalModelBinding(
  accountId: string,
  workspaceId: string
): ManagedLocalModelBinding | null {
  return readBindings()[bindingKey(accountId, workspaceId)] ?? null;
}

export function writeManagedLocalModelBinding(
  accountId: string,
  workspaceId: string,
  binding: ManagedLocalModelBinding
): void {
  const bindings = readBindings();
  bindings[bindingKey(accountId, workspaceId)] = binding;
  localStorage.setItem(MANAGED_LOCAL_MODEL_BINDINGS_KEY, JSON.stringify(bindings));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("openwhispr-managed-local-model-binding"));
  }
}

export function setManagedLocalModelBindingError(
  accountId: string,
  workspaceId: string,
  configVersion: number,
  error: string | null
): void {
  const binding = readManagedLocalModelBinding(accountId, workspaceId);
  if (!binding || binding.configVersion !== configVersion) return;
  writeManagedLocalModelBinding(accountId, workspaceId, { ...binding, error });
}

export function setManagedLocalModelCategoryError(
  accountId: string,
  workspaceId: string,
  configVersion: number,
  category: ManagedLocalModelCategory,
  error: string | null
): void {
  const binding = readManagedLocalModelBinding(accountId, workspaceId);
  if (!binding || binding.configVersion !== configVersion) return;
  const categoryErrors = { ...binding.categoryErrors };
  if (error) categoryErrors[category] = error;
  else delete categoryErrors[category];
  writeManagedLocalModelBinding(accountId, workspaceId, {
    ...binding,
    categoryErrors,
  });
}

export function clearManagedLocalModelCategoryError(
  binding: ManagedLocalModelBinding,
  category: ManagedLocalModelCategory
): ManagedLocalModelBinding {
  const categoryErrors = { ...binding.categoryErrors };
  delete categoryErrors[category];
  return { ...binding, categoryErrors };
}

export function createResolvedManagedLocalModelBinding(
  binding: ManagedLocalModelBinding,
  configVersion: number,
  transcription: ManagedEnterpriseLocalModelSelection | null,
  reasoning: ManagedEnterpriseLocalModelSelection | null
): ManagedLocalModelBinding {
  return {
    configVersion,
    transcription,
    reasoning,
    error: null,
    categoryErrors: binding.configVersion === configVersion ? binding.categoryErrors : {},
    retryGeneration: binding.retryGeneration,
  };
}

export function getManagedLocalModelBindingError(
  binding: ManagedLocalModelBinding | null
): string | null {
  return (
    binding?.error ??
    binding?.categoryErrors?.transcription ??
    binding?.categoryErrors?.reasoning ??
    null
  );
}

export function shouldRecoverManagedLocalModel(
  selection: ManagedEnterpriseLocalModelSelection | null,
  installed: boolean,
  downloading: boolean
): boolean {
  return Boolean(selection && !installed && !downloading);
}

export function shouldRecoverManagedLocalModelFromInventory(
  selection: ManagedEnterpriseLocalModelSelection | null,
  inventoryKnown: boolean,
  installed: boolean,
  downloading: boolean
): boolean {
  return inventoryKnown && shouldRecoverManagedLocalModel(selection, installed, downloading);
}

const MANAGED_LOCAL_MODEL_INVENTORY_RETRY_DELAYS_MS = [250, 1000, 3000] as const;

export function getManagedLocalModelInventoryRetryDelay(completedAttempts: number): number | null {
  return MANAGED_LOCAL_MODEL_INVENTORY_RETRY_DELAYS_MS[completedAttempts - 1] ?? null;
}

export function resolveManagedLocalModelInventorySnapshot<T>(
  current: T,
  next: T | undefined
): { value: T; known: boolean } {
  return next === undefined ? { value: current, known: false } : { value: next, known: true };
}

interface ManagedLocalModelLockSnapshotInput {
  accountId: string | null;
  workspaceId: string | null;
  localModels: ManagedEnterpriseLocalModels | null;
  localModelsKnown: boolean;
  failClosed: boolean;
}

export function resolveManagedLocalModelLockSnapshot(
  state: ManagedLocalModelLockSnapshotInput,
  category: ManagedLocalModelCategory
): {
  managed: boolean;
  selection: ManagedEnterpriseLocalModelSelection | null;
} {
  if (!state.accountId || !state.workspaceId) return { managed: false, selection: null };
  const approved = state.localModels?.[category] ?? [];
  const managed = approved.length > 0 || (state.failClosed && !state.localModelsKnown);
  if (!managed) return { managed: false, selection: null };
  const binding = readManagedLocalModelBinding(state.accountId, state.workspaceId);
  const selection = binding?.[category] ?? null;
  return {
    managed: true,
    selection: isApprovedManagedLocalModel(approved, selection) ? selection : null,
  };
}

export function resolveManagedLocalModelSelection(
  approved: ManagedEnterpriseLocalModelSelection[],
  current: ManagedEnterpriseLocalModelSelection | null | undefined
): ManagedEnterpriseLocalModelSelection | null {
  if (approved.length === 0) return null;
  if (
    current &&
    approved.some(
      (model) => model.provider === current.provider && model.modelId === current.modelId
    )
  ) {
    return current;
  }
  return approved[0];
}

export function requiresManagedLocalModels(config: ManagedEnterpriseLocalModels | null): boolean {
  return Boolean(config && (config.transcription.length > 0 || config.reasoning.length > 0));
}

export function isApprovedManagedLocalModel(
  approved: ManagedEnterpriseLocalModelSelection[],
  selection: ManagedEnterpriseLocalModelSelection | null | undefined
): boolean {
  return Boolean(
    selection &&
    approved.some(
      (model) => model.provider === selection.provider && model.modelId === selection.modelId
    )
  );
}

export function areManagedLocalModelBindingsReady(
  config: ManagedEnterpriseLocalModels | null,
  binding: ManagedLocalModelBinding | null
): boolean {
  if (!requiresManagedLocalModels(config)) return true;
  if (!config || !binding || getManagedLocalModelBindingError(binding)) return false;
  return (
    (config.transcription.length === 0 ||
      isApprovedManagedLocalModel(config.transcription, binding.transcription)) &&
    (config.reasoning.length === 0 ||
      isApprovedManagedLocalModel(config.reasoning, binding.reasoning))
  );
}
