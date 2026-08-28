import { useEffect, useState, useSyncExternalStore } from "react";
import { authClient, getGracePeriodRemainingMs, isWithinGracePeriod } from "../lib/auth";
import {
  accountScopeHasMandatoryReconciliation,
  accountScopeRequiresPurge,
  accountScopeRequiresReconciliation,
  getAccountScopeRevision,
  getAccountScopeServerRevision,
  isAccountScopeRetryWaiting,
  markAccountScopePurgeRequired,
  reconcileAccountScope,
  resetAccountScopeRetry,
  scheduleAccountScopeRetry,
  shouldBlockAccountScope,
  shouldReconcileAccountScope,
  subscribeAccountScope,
} from "../lib/authAccountScope";
import {
  assertAuthGenerationCurrent,
  commitValidatedAuthContext,
  getAuthRequestContextServerSnapshot,
  getAuthRequestContextSnapshot,
  getBoundSessionGeneration,
  getValidatedAuthGeneration,
  invalidateValidatedAuthContext,
  subscribeAuthRequestContext,
} from "../lib/authRequestContext";
import logger from "../utils/logger";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { useEnterpriseIdentityStore } from "../stores/enterpriseIdentityStore";

const useStaticSession = () => ({
  data: null,
  isPending: false,
  error: null,
  refetch: async () => null,
});

async function loadAccountDependencies() {
  const [
    { syncService },
    { invalidateSpaceRoster },
    { resetForAccountChange },
    { useWorkspaceStore },
  ] = await Promise.all([
    import("../services/SyncService.js"),
    import("../lib/spaceRosterCache"),
    import("../stores/noteStore"),
    import("../stores/workspaceStore"),
  ]);

  const resetRendererCaches = () => {
    invalidateSpaceRoster();
    resetForAccountChange();
    useWorkspaceStore.getState().resetForAccountChange();
  };
  return { syncService, resetRendererCaches };
}

async function refreshManagedEnterpriseIdentity(accountId: string, authGeneration: number) {
  const { refreshManagedEnterpriseIdentity: refresh, useWorkspaceStore } =
    await import("../stores/workspaceStore");
  // A newly authenticated employee has no active workspace cached yet. Load
  // memberships first so a single SCIM-provisioned Enterprise workspace is
  // selected and its managed provider config resolves without opening Settings.
  await useWorkspaceStore.getState().refresh();
  refresh(accountId, authGeneration);
}

export function useAuth() {
  const useSession = authClient?.useSession ?? useStaticSession;
  const { data: ambientSession, isPending, error: sessionError, refetch } = useSession();
  const accountRevision = useSyncExternalStore(
    subscribeAccountScope,
    getAccountScopeRevision,
    getAccountScopeServerRevision
  );
  const authContext = useSyncExternalStore(
    subscribeAuthRequestContext,
    getAuthRequestContextSnapshot,
    getAuthRequestContextServerSnapshot
  );
  const [, setGraceExpiryTick] = useState(0);

  const ambientUser = ambientSession?.user ?? null;
  const ambientUserId = typeof ambientUser?.id === "string" ? ambientUser.id : null;
  // Not gated on sessionError: the binding survives a transient refetch failure
  // and is cleared on its own by a 401 or a credential-generation change.
  const boundGeneration = isPending ? null : getBoundSessionGeneration(ambientUserId);
  const sessionIsBound = boundGeneration != null;
  const resolvedUserId = sessionIsBound ? ambientUserId : null;
  const rawIsSignedIn = sessionIsBound && Boolean(ambientUser);
  const gracePeriodActive = sessionIsBound && !rawIsSignedIn && isWithinGracePeriod();
  const sessionResolutionFailed = Boolean(sessionError) || (!isPending && !sessionIsBound);
  const requiresReconciliation = sessionIsBound
    ? accountScopeRequiresReconciliation(resolvedUserId)
    : true;
  const cloudContextReady = !rawIsSignedIn || getValidatedAuthGeneration() === boundGeneration;
  const accountScopeBlocked =
    isPending ||
    shouldBlockAccountScope(
      isPending,
      gracePeriodActive,
      rawIsSignedIn,
      requiresReconciliation,
      accountScopeHasMandatoryReconciliation(),
      sessionResolutionFailed
    ) ||
    !cloudContextReady;
  // A reconciled session whose refetch failed transiently keeps its binding but
  // loses its validated lease. Keep presenting it instead of flashing to guest;
  // sync stays fenced by getValidatedAuthGeneration() until a refetch succeeds.
  const transientlyAuthenticated =
    Boolean(sessionError) &&
    rawIsSignedIn &&
    !requiresReconciliation &&
    !accountScopeHasMandatoryReconciliation();
  const accountScopePresentable = !accountScopeBlocked || transientlyAuthenticated;
  const isSignedIn = rawIsSignedIn && accountScopePresentable;
  // Loaded means the session settled: fully validated, or failed/signed-out
  // (presented as a guest). Resolution failure must not hold windows hostage —
  // dictation works without an account, and sync stays fenced by
  // hasValidatedAuthContext either way.
  const isLoaded = !isPending && (sessionResolutionFailed || !accountScopeBlocked);

  useEffect(() => {
    if (!gracePeriodActive) return;
    const remaining = getGracePeriodRemainingMs();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setGraceExpiryTick((value) => value + 1), remaining + 10);
    return () => window.clearTimeout(timer);
  }, [gracePeriodActive]);

  useEffect(() => {
    if (!sessionError) return;
    invalidateValidatedAuthContext();
  }, [sessionError]);

  useEffect(() => {
    if (!sessionResolutionFailed || !resolvedUserId || boundGeneration == null) return;
    void usePolicyStore.getState().fetchPolicy(resolvedUserId, boundGeneration);
    void refreshManagedEnterpriseIdentity(resolvedUserId, boundGeneration);
  }, [boundGeneration, resolvedUserId, sessionResolutionFailed]);

  useEffect(() => {
    if (
      boundGeneration == null ||
      !shouldReconcileAccountScope(
        isPending,
        gracePeriodActive,
        rawIsSignedIn,
        sessionResolutionFailed
      )
    ) {
      return;
    }
    const retryKey = `${boundGeneration}:${resolvedUserId ?? "signed-out"}`;
    if (isAccountScopeRetryWaiting(retryKey)) return;

    let cancelled = false;
    const run = async () => {
      const { syncService, resetRendererCaches } = await loadAccountDependencies();
      const scopeResult = await window.electronAPI?.setActiveAccountScope?.(
        resolvedUserId,
        boundGeneration
      );
      if (!scopeResult?.success) {
        throw new Error(scopeResult?.error ?? "Could not establish the local account scope");
      }
      const purgeCachedTeamContent = async () => {
        resetRendererCaches();
        await syncService.purgeTeamSpacesForSignOut();
        resetRendererCaches();
      };
      const verifyCachedTeamContent = async () => {
        const purged = await syncService.verifyTeamSpacesForAccount(boundGeneration);
        if (purged > 0) resetRendererCaches();
      };

      if (accountScopeRequiresPurge(resolvedUserId)) {
        markAccountScopePurgeRequired();
      }
      if (accountScopeRequiresReconciliation(resolvedUserId)) {
        // This legacy marker drives every already-running SyncService window;
        // its generation gate provides the immediate fence.
        useSettingsStore.getState().setIsSignedIn(false);
        usePolicyStore.getState().suspendPolicy();
      }

      await reconcileAccountScope(resolvedUserId, {
        purge: purgeCachedTeamContent,
        verify: verifyCachedTeamContent,
      });

      if (resolvedUserId) {
        await assertAuthGenerationCurrent(boundGeneration);
        if (!commitValidatedAuthContext(boundGeneration, resolvedUserId)) {
          throw new Error("Resolved session no longer matches the active credential");
        }
        if (!cancelled) {
          logger.debug("Auth state sync", { isSignedIn: true, userId: resolvedUserId }, "auth");
          useSettingsStore.getState().setIsSignedIn(true);
          void usePolicyStore.getState().fetchPolicy(resolvedUserId, boundGeneration);
          void refreshManagedEnterpriseIdentity(resolvedUserId, boundGeneration);
        }
      } else {
        invalidateValidatedAuthContext();
        if (!cancelled) {
          useSettingsStore.getState().setIsSignedIn(false);
          usePolicyStore.getState().clearPolicy();
          useEnterpriseIdentityStore.getState().clear();
        }
      }
      resetAccountScopeRetry();
    };

    void run().catch((error) => {
      invalidateValidatedAuthContext();
      scheduleAccountScopeRetry(retryKey);
      logger.error("Account-scoped content reconciliation failed", { error }, "auth");
    });

    return () => {
      cancelled = true;
    };
  }, [
    accountRevision,
    authContext.revision,
    boundGeneration,
    gracePeriodActive,
    isPending,
    rawIsSignedIn,
    resolvedUserId,
    sessionResolutionFailed,
  ]);

  return {
    isSignedIn,
    isGracePeriodOnly: gracePeriodActive,
    isLoaded,
    session: sessionIsBound && accountScopePresentable ? ambientSession : null,
    user: isSignedIn ? ambientUser : null,
    refetch,
  };
}
