import type { ManagedEnterpriseLocalModelSelection } from "../../types/enterpriseIdentity";

export const MANAGED_LOCAL_MODEL_BINDINGS_KEY = "enterpriseManagedLocalModelBindingsV1";
export const MANAGED_LOCAL_MODEL_LOCK_NAME = "openwhispr-managed-local-model-reconciliation";
export const MANAGED_LOCAL_MODEL_BINDINGS_CHANGED_EVENT =
  "openwhispr-managed-local-model-bindings-changed";

export type ManagedLocalModelCategory = "dictation" | "assistant";
export type ManagedLocalModelAvailability = "installed" | "downloading" | "missing";
export type ManagedLocalNvidiaCapability = "supported" | "unsupported" | "unknown";

export interface ManagedLocalModelIdentity {
  accountId: string;
  workspaceId: string;
  authGeneration: number;
  configGeneration: number;
}

export interface ManagedLocalModelBinding extends ManagedLocalModelIdentity {
  category: ManagedLocalModelCategory;
  provider: string;
  model: string;
}

type ManagedLocalModelBindings = Partial<
  Record<ManagedLocalModelCategory, ManagedLocalModelBinding>
>;

export interface ManagedLocalModelReconciliationInput {
  identity: ManagedLocalModelIdentity;
  category: ManagedLocalModelCategory;
  approvedSelections: ManagedEnterpriseLocalModelSelection[];
  availability: Record<string, ManagedLocalModelAvailability | undefined>;
  nvidiaCapability: ManagedLocalNvidiaCapability;
  binding: ManagedLocalModelBinding | null;
}

export type ManagedLocalModelReconciliationPlan =
  | {
      kind: "apply" | "wait" | "download";
      selection: ManagedEnterpriseLocalModelSelection;
      persistBinding: boolean;
      startDownload: boolean;
    }
  | {
      kind: "pause";
      code: "MANAGED_LOCAL_CAPABILITY_UNKNOWN";
      selection: null;
      persistBinding: false;
      startDownload: false;
    }
  | {
      kind: "error";
      code:
        | "MANAGED_LOCAL_NO_COMPATIBLE_DICTATION_MODEL"
        | "MANAGED_LOCAL_NO_COMPATIBLE_ASSISTANT_MODEL";
      messageKey:
        | "onboarding.managedLocal.errors.noCompatibleDictationModel"
        | "onboarding.managedLocal.errors.noCompatibleAssistantModel";
      selection: null;
      persistBinding: false;
      startDownload: false;
    };

export interface ManagedLocalModelLockLifetime {
  release: () => void;
  finished: Promise<void>;
}

export interface ManagedLocalModelLockLifetimeOptions {
  onOwnershipChange: (ownsLock: boolean) => void;
  onReconcileError?: (error: unknown) => void;
  reconcile: () => Promise<void>;
}

function isBrowserStorageAvailable(): boolean {
  return typeof localStorage !== "undefined";
}

function isManagedLocalModelBinding(value: unknown): value is ManagedLocalModelBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<ManagedLocalModelBinding>;
  return (
    (binding.category === "dictation" || binding.category === "assistant") &&
    typeof binding.accountId === "string" &&
    typeof binding.workspaceId === "string" &&
    typeof binding.authGeneration === "number" &&
    typeof binding.configGeneration === "number" &&
    typeof binding.provider === "string" &&
    typeof binding.model === "string"
  );
}

function isExactIdentity(
  binding: ManagedLocalModelBinding,
  identity: ManagedLocalModelIdentity
): boolean {
  return (
    binding.accountId === identity.accountId &&
    binding.workspaceId === identity.workspaceId &&
    binding.authGeneration === identity.authGeneration &&
    binding.configGeneration === identity.configGeneration
  );
}

function isExactBinding(left: ManagedLocalModelBinding, right: ManagedLocalModelBinding): boolean {
  return (
    isExactIdentity(left, right) &&
    left.category === right.category &&
    left.provider === right.provider &&
    left.model === right.model
  );
}

export function managedLocalModelCategory(
  selection: ManagedEnterpriseLocalModelSelection
): ManagedLocalModelCategory {
  return selection.provider === "whisper" || selection.provider === "nvidia"
    ? "dictation"
    : "assistant";
}

export function managedLocalModelSelectionKey(
  selection: ManagedEnterpriseLocalModelSelection
): string {
  return `${selection.provider}:${selection.model}`;
}

function isApprovedSelection(
  binding: ManagedLocalModelBinding,
  approvedSelections: ManagedEnterpriseLocalModelSelection[]
): boolean {
  return approvedSelections.some(
    (selection) => selection.provider === binding.provider && selection.model === binding.model
  );
}

export function readManagedLocalModelBindings(): ManagedLocalModelBindings {
  if (!isBrowserStorageAvailable()) return {};
  try {
    const value = localStorage.getItem(MANAGED_LOCAL_MODEL_BINDINGS_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as ManagedLocalModelBindings;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([category, binding]) =>
          (category === "dictation" || category === "assistant") &&
          isManagedLocalModelBinding(binding)
      )
    ) as ManagedLocalModelBindings;
  } catch {
    return {};
  }
}

function writeManagedLocalModelBindings(bindings: ManagedLocalModelBindings): void {
  if (!isBrowserStorageAvailable()) return;
  if (Object.keys(bindings).length === 0) {
    localStorage.removeItem(MANAGED_LOCAL_MODEL_BINDINGS_KEY);
  } else {
    localStorage.setItem(MANAGED_LOCAL_MODEL_BINDINGS_KEY, JSON.stringify(bindings));
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(MANAGED_LOCAL_MODEL_BINDINGS_CHANGED_EVENT));
  }
}

export function getManagedLocalModelBindingSnapshot(): string {
  return isBrowserStorageAvailable()
    ? (localStorage.getItem(MANAGED_LOCAL_MODEL_BINDINGS_KEY) ?? "")
    : "";
}

export function subscribeManagedLocalModelBindings(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {};
  }
  const handleStorage = (event: StorageEvent): void => {
    if (event.key === MANAGED_LOCAL_MODEL_BINDINGS_KEY) onChange();
  };
  window.addEventListener(MANAGED_LOCAL_MODEL_BINDINGS_CHANGED_EVENT, onChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(MANAGED_LOCAL_MODEL_BINDINGS_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function readManagedLocalModelBinding(
  identity: ManagedLocalModelIdentity,
  category: ManagedLocalModelCategory
): ManagedLocalModelBinding | null {
  const binding = readManagedLocalModelBindings()[category];
  return binding && isExactIdentity(binding, identity) ? binding : null;
}

export function rememberManagedLocalModelBinding(binding: ManagedLocalModelBinding): void {
  writeManagedLocalModelBindings({
    ...readManagedLocalModelBindings(),
    [binding.category]: binding,
  });
}

export function consumeManagedLocalModelBinding(
  expected: ManagedLocalModelBinding
): ManagedLocalModelBinding | null {
  const bindings = readManagedLocalModelBindings();
  const current = bindings[expected.category];
  if (!current || !isExactBinding(current, expected)) return null;
  delete bindings[expected.category];
  writeManagedLocalModelBindings(bindings);
  return current;
}

export function isCurrentManagedLocalModelBinding(
  binding: ManagedLocalModelBinding | null,
  identity: ManagedLocalModelIdentity,
  category: ManagedLocalModelCategory,
  approvedSelections: ManagedEnterpriseLocalModelSelection[]
): binding is ManagedLocalModelBinding {
  return Boolean(
    binding &&
    binding.category === category &&
    isExactIdentity(binding, identity) &&
    isApprovedSelection(binding, approvedSelections)
  );
}

function categoryError(category: ManagedLocalModelCategory): ManagedLocalModelReconciliationPlan {
  return category === "dictation"
    ? {
        kind: "error",
        code: "MANAGED_LOCAL_NO_COMPATIBLE_DICTATION_MODEL",
        messageKey: "onboarding.managedLocal.errors.noCompatibleDictationModel",
        selection: null,
        persistBinding: false,
        startDownload: false,
      }
    : {
        kind: "error",
        code: "MANAGED_LOCAL_NO_COMPATIBLE_ASSISTANT_MODEL",
        messageKey: "onboarding.managedLocal.errors.noCompatibleAssistantModel",
        selection: null,
        persistBinding: false,
        startDownload: false,
      };
}

/** Purely chooses the next managed local-model action; the coordinator owns every side effect. */
export function planManagedLocalModelReconciliation(
  input: ManagedLocalModelReconciliationInput
): ManagedLocalModelReconciliationPlan {
  const approved = input.approvedSelections.filter(
    (selection) => managedLocalModelCategory(selection) === input.category
  );
  const current = isCurrentManagedLocalModelBinding(
    input.binding,
    input.identity,
    input.category,
    approved
  );
  const candidates = current
    ? [
        { provider: input.binding.provider, model: input.binding.model },
        ...approved.filter(
          (selection) =>
            selection.provider !== input.binding.provider || selection.model !== input.binding.model
        ),
      ]
    : approved;

  for (const selection of candidates) {
    if (selection.provider === "nvidia") {
      if (input.nvidiaCapability === "unknown") {
        return {
          kind: "pause",
          code: "MANAGED_LOCAL_CAPABILITY_UNKNOWN",
          selection: null,
          persistBinding: false,
          startDownload: false,
        };
      }
      if (input.nvidiaCapability === "unsupported") continue;
    }
    const availability = input.availability[managedLocalModelSelectionKey(selection)] ?? "missing";
    const persistBinding =
      !current ||
      selection.provider !== input.binding.provider ||
      selection.model !== input.binding.model;
    if (availability === "installed") {
      return { kind: "apply", selection, persistBinding, startDownload: false };
    }
    if (availability === "downloading") {
      return { kind: "wait", selection, persistBinding, startDownload: false };
    }
    return { kind: "download", selection, persistBinding, startDownload: true };
  }

  return categoryError(input.category);
}

export async function withManagedLocalModelLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return task();
  return navigator.locks.request(MANAGED_LOCAL_MODEL_LOCK_NAME, task);
}

/** Holds the cross-window lock for a mounted eligible controller, not only reconciliation. */
export function holdManagedLocalModelLock(
  options: ManagedLocalModelLockLifetimeOptions
): ManagedLocalModelLockLifetime {
  let released = false;
  let resolveRelease: (() => void) | null = null;
  const releasedPromise = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  const finished = withManagedLocalModelLock(async () => {
    if (released) return;
    options.onOwnershipChange(true);
    try {
      try {
        await options.reconcile();
      } catch (error) {
        options.onReconcileError?.(error);
      }
      await releasedPromise;
    } finally {
      options.onOwnershipChange(false);
    }
  });
  return {
    release: () => {
      if (released) return;
      released = true;
      resolveRelease?.();
    },
    finished,
  };
}
