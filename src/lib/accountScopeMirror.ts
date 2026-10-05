import { useEnterpriseIdentityStore } from "../stores/enterpriseIdentityStore";
import { usePolicyStore } from "../stores/policyStore";
import { ACTIVE_WORKSPACE_KEY, refreshManagedEnterpriseIdentity } from "../stores/workspaceStore";
import type { ActiveAccountScope } from "../types/electron";

/**
 * Hydrates the workspace policy and managed enterprise identity in a window
 * that cannot resolve its own session. The dictation window is sandboxed with
 * web security enforced, so Better Auth's cross-origin session fetch fails
 * there and the session-driven hydration in useAuth never runs. The control
 * panel validates the session and the main process persists that scope; this
 * mirrors it back over IPC, both the value at boot and every later change
 * (re-validation under a new credential generation, sign-out). The active
 * workspace is the control panel's choice, read from the localStorage key it
 * writes, which every window of this origin shares.
 */
export function mirrorActiveAccountScope(): () => void {
  let scope: ActiveAccountScope | null = null;
  let broadcastReceived = false;

  const refreshIdentity = () => {
    if (!scope) return;
    refreshManagedEnterpriseIdentity(
      scope.accountId,
      scope.authGeneration,
      localStorage.getItem(ACTIVE_WORKSPACE_KEY)
    );
  };
  const applyScope = (next: ActiveAccountScope | null) => {
    scope = next;
    if (!next) {
      usePolicyStore.getState().clearPolicy();
      useEnterpriseIdentityStore.getState().clear();
      return;
    }
    void usePolicyStore.getState().fetchPolicy(next.accountId, next.authGeneration);
    refreshIdentity();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACTIVE_WORKSPACE_KEY) refreshIdentity();
  };

  window.addEventListener("storage", onStorage);
  const unsubscribe = window.electronAPI?.onActiveAccountScopeChanged?.((next) => {
    broadcastReceived = true;
    applyScope(next);
  });
  // A scope validated while the boot read was in flight has already arrived by
  // broadcast; the read's answer is the older of the two.
  void window.electronAPI?.getActiveAccountScope?.().then((next) => {
    if (!broadcastReceived) applyScope(next);
  });
  return () => {
    window.removeEventListener("storage", onStorage);
    unsubscribe?.();
  };
}
