const ACCOUNT_SCOPE_USER_KEY = "openwhispr:accountScopeUserId";
const ACCOUNT_SCOPE_VALIDATED_KEY = "openwhispr:accountScopeValidated";
const ACCOUNT_SCOPE_PURGE_REQUIRED_KEY = "openwhispr:accountScopePurgeRequired";

export type AccountScopeAction = "none" | "remember-user" | "verify" | "purge";

export interface AccountScopeDecisionInput {
  userId: string | null;
  previousUserId: string | null;
  wasSignedIn: boolean;
  hasTeamSpaces: boolean;
  scopeValidated: boolean;
  purgeRequired?: boolean;
  pendingAction?: "verify" | "purge" | null;
}

/**
 * A known user replacement/sign-out requires destructive cleanup. A
 * marker-less upgrade with a resolved user is different: prove its local
 * space memberships before deciding which rows are foreign.
 */
export function decideAccountScopeAction({
  userId,
  previousUserId,
  wasSignedIn,
  hasTeamSpaces,
  scopeValidated,
  purgeRequired = false,
  pendingAction = null,
}: AccountScopeDecisionInput): AccountScopeAction {
  if (purgeRequired) return "purge";
  if (pendingAction) return pendingAction;
  if (!scopeValidated) {
    if (userId) return "verify";
    return wasSignedIn || previousUserId != null || hasTeamSpaces ? "purge" : "remember-user";
  }

  if (!userId) {
    return wasSignedIn || previousUserId != null || hasTeamSpaces ? "purge" : "none";
  }
  if (previousUserId != null && previousUserId !== userId) return "purge";
  if (!wasSignedIn && (previousUserId != null || hasTeamSpaces)) return "purge";
  return previousUserId === userId ? "none" : "remember-user";
}

export interface AccountScopeReconcileCallbacks {
  purge: () => Promise<void>;
  verify: () => Promise<void>;
}

let pendingAction: "verify" | "purge" | null = null;
let revision = 0;
let activeReconcile: Promise<void> | null = null;
let queuedReconcile:
  | {
      userId: string | null;
      callbacks: AccountScopeReconcileCallbacks;
    }
  | undefined;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryKey: string | null = null;
let retryAttempt = 0;
const subscribers = new Set<() => void>();

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function notify(): void {
  revision += 1;
  subscribers.forEach((subscriber) => subscriber());
}

function readPreviousUserId(): string | null {
  return storage()?.getItem(ACCOUNT_SCOPE_USER_KEY) ?? null;
}

function writePreviousUserId(userId: string | null): void {
  const target = storage();
  if (!target) return;
  if (userId) target.setItem(ACCOUNT_SCOPE_USER_KEY, userId);
  else target.removeItem(ACCOUNT_SCOPE_USER_KEY);
}

function markScopeValidated(): void {
  storage()?.setItem(ACCOUNT_SCOPE_VALIDATED_KEY, "true");
}

export function getAccountScopeAction(userId: string | null): AccountScopeAction {
  const target = storage();
  return decideAccountScopeAction({
    userId,
    previousUserId: readPreviousUserId(),
    wasSignedIn: target?.getItem("isSignedIn") === "true",
    hasTeamSpaces: target?.getItem("teamSpacesCapability") === "true",
    scopeValidated: target?.getItem(ACCOUNT_SCOPE_VALIDATED_KEY) === "true",
    purgeRequired: target?.getItem(ACCOUNT_SCOPE_PURGE_REQUIRED_KEY) === "true",
    pendingAction,
  });
}

export function accountScopeRequiresPurge(userId: string | null): boolean {
  return getAccountScopeAction(userId) === "purge";
}

export function accountScopeRequiresReconciliation(userId: string | null): boolean {
  return getAccountScopeAction(userId) !== "none";
}

export function accountScopeHasMandatoryReconciliation(): boolean {
  const target = storage();
  return (
    pendingAction != null ||
    target?.getItem(ACCOUNT_SCOPE_PURGE_REQUIRED_KEY) === "true" ||
    target?.getItem(ACCOUNT_SCOPE_VALIDATED_KEY) !== "true"
  );
}

export function markAccountScopePurgeRequired(): void {
  storage()?.setItem(ACCOUNT_SCOPE_PURGE_REQUIRED_KEY, "true");
  notify();
}

export function subscribeAccountScope(onChange: () => void): () => void {
  subscribers.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === ACCOUNT_SCOPE_USER_KEY ||
      event.key === ACCOUNT_SCOPE_VALIDATED_KEY ||
      event.key === ACCOUNT_SCOPE_PURGE_REQUIRED_KEY ||
      event.key === "isSignedIn" ||
      event.key === "teamSpacesCapability"
    ) {
      notify();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    subscribers.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getAccountScopeRevision(): number {
  return revision;
}

export function getAccountScopeServerRevision(): number {
  return 0;
}

async function applyReconcile(
  userId: string | null,
  callbacks: AccountScopeReconcileCallbacks
): Promise<void> {
  const action = getAccountScopeAction(userId);
  if (action === "none") return;
  if (action === "remember-user") {
    writePreviousUserId(userId);
    markScopeValidated();
    storage()?.setItem("isSignedIn", userId ? "true" : "false");
    notify();
    return;
  }

  if (action === "purge") {
    // Persist before cleanup starts: capability flags may disappear even when
    // a database operation fails, and must not reopen the gate.
    markAccountScopePurgeRequired();
  }
  pendingAction = action;
  notify();
  try {
    if (action === "purge") await callbacks.purge();
    else await callbacks.verify();
    writePreviousUserId(userId);
    markScopeValidated();
    const target = storage();
    target?.setItem("isSignedIn", userId ? "true" : "false");
    target?.removeItem(ACCOUNT_SCOPE_PURGE_REQUIRED_KEY);
  } finally {
    pendingAction = null;
    notify();
  }
}

export function shouldBlockAccountScope(
  isPending: boolean,
  gracePeriodActive: boolean,
  rawIsSignedIn: boolean,
  requiresReconciliation: boolean,
  mandatoryReconciliation = false,
  sessionResolutionFailed = false
): boolean {
  if (sessionResolutionFailed) {
    return !isPending && (requiresReconciliation || mandatoryReconciliation);
  }
  return (
    !isPending &&
    requiresReconciliation &&
    (mandatoryReconciliation || !gracePeriodActive || rawIsSignedIn)
  );
}

export function shouldReconcileAccountScope(
  isPending: boolean,
  gracePeriodActive: boolean,
  rawIsSignedIn: boolean,
  sessionResolutionFailed = false
): boolean {
  return !isPending && !sessionResolutionFailed && (!gracePeriodActive || rawIsSignedIn);
}

/**
 * Serialize reconciliation across all useAuth consumers in this renderer. A
 * later identity is queued and re-evaluated after the current operation.
 */
export function reconcileAccountScope(
  userId: string | null,
  callbacks: AccountScopeReconcileCallbacks
): Promise<void> {
  queuedReconcile = { userId, callbacks };
  if (activeReconcile) return activeReconcile;

  activeReconcile = (async () => {
    while (queuedReconcile) {
      const next = queuedReconcile;
      queuedReconcile = undefined;
      await applyReconcile(next.userId, next.callbacks);
    }
  })().finally(() => {
    activeReconcile = null;
  });
  return activeReconcile;
}

export function accountScopeRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 30_000);
}

export function scheduleAccountScopeRetry(key: string): void {
  if (retryKey !== key) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryKey = key;
    retryAttempt = 0;
  }
  if (retryTimer) return;
  const delay = accountScopeRetryDelay(retryAttempt);
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    notify();
  }, delay);
}

export function isAccountScopeRetryWaiting(key: string): boolean {
  return retryKey === key && retryTimer != null;
}

export function resetAccountScopeRetry(key?: string): void {
  if (key && retryKey !== key) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryKey = null;
  retryAttempt = 0;
}
