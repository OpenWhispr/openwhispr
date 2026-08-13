import { create } from "zustand";
import logger from "../utils/logger";
import type { OrgPolicy } from "../types/policy";
import {
  POLICY_SUCCESS_REFRESH_MS,
  resolvedPolicyRefreshIdentity,
  shouldAcceptPolicySnapshot,
  shouldPreserveResolvedPolicyOnFailure,
} from "./policyLifecycle";
import type { PolicyDecisionSnapshot } from "./policyRules";

export interface PolicyState extends PolicyDecisionSnapshot {
  /** Account whose policy is represented by this renderer state. */
  accountId: string | null;
  authGeneration: number | null;
  revision: number;
  /** True once the org enforces a policy on this user. */
  managed: boolean;
  fetchPolicy: (accountId: string, authGeneration: number) => Promise<void>;
  clearPolicy: () => void;
  /**
   * Fail-closed placeholder while account reconciliation resolves the active
   * identity. Unlike clearPolicy (idle = allowed), "loading" denies managed
   * actions until the new account's policy is fetched.
   */
  suspendPolicy: () => void;
}

// Several components mount useAuth at startup; share one in-flight fetch
// between them instead of hitting the API once per consumer.
let fetchInFlight: {
  accountId: string;
  authGeneration: number;
  promise: Promise<void>;
} | null = null;
let fetchSequence = 0;
let lifecycleListenersReady = false;
let appVersionPromise: Promise<string | null> | null = null;

interface PolicyIpcSnapshot {
  success: boolean;
  status?: string;
  revision?: number;
  accountId?: string | null;
  authGeneration?: number | null;
  managed?: boolean;
  policy?: OrgPolicy | null;
  policyUpdatedAt?: string | null;
  endpointSupported?: boolean;
  code?: string;
  error?: string;
}

function readAppVersion(): Promise<string | null> {
  if (!appVersionPromise) {
    const pending: Promise<string | null> =
      window.electronAPI
        .getAppVersion?.()
        .then((result) => result?.version ?? null)
        .catch((error) => {
          logger.error("Failed to read app version for workspace policy:", error);
          return null;
        }) ?? Promise.resolve(null);
    // An unknown version denies every managed action while hiding the update
    // banner that explains it, so never cache a failed read for the session.
    appVersionPromise = pending.then((version) => {
      if (!version) appVersionPromise = null;
      return version;
    });
  }
  return appVersionPromise;
}

function normalizeSnapshot(
  result: PolicyIpcSnapshot,
  current: PolicyState
): Required<
  Pick<PolicyIpcSnapshot, "revision" | "accountId" | "authGeneration" | "managed" | "policy">
> {
  return {
    revision: result.revision ?? current.revision + 1,
    // A mixed new-renderer/old-main response has no credential identity. It
    // must never inherit the renderer's requested account or generation,
    // because an older main may be returning a global cache from another user.
    accountId: result.accountId ?? null,
    authGeneration: result.authGeneration ?? null,
    managed: Boolean(result.managed),
    policy: result.policy ?? null,
  };
}

function applyPolicySnapshot(result: PolicyIpcSnapshot, appVersion: string | null): boolean {
  const current = usePolicyStore.getState();
  const snapshot = normalizeSnapshot(result, current);
  if (
    !current.accountId ||
    current.authGeneration == null ||
    snapshot.accountId !== current.accountId ||
    snapshot.authGeneration !== current.authGeneration ||
    !shouldAcceptPolicySnapshot(
      {
        accountId: current.accountId,
        authGeneration: current.authGeneration,
        revision: current.revision,
      },
      {
        accountId: snapshot.accountId,
        authGeneration: snapshot.authGeneration,
        revision: snapshot.revision,
      }
    )
  ) {
    return false;
  }

  if (snapshot.managed && !snapshot.policy) return false;
  usePolicyStore.setState({
    accountId: snapshot.accountId,
    authGeneration: snapshot.authGeneration,
    revision: snapshot.revision,
    status: snapshot.managed ? "managed" : "unmanaged",
    managed: snapshot.managed,
    policy: snapshot.policy,
    appVersion,
  });
  return true;
}

function applyPolicyFailure(result: PolicyIpcSnapshot): boolean {
  const current = usePolicyStore.getState();
  if (
    result.code !== "POLICY_UNRESOLVABLE" ||
    !current.accountId ||
    current.authGeneration == null ||
    result.accountId !== current.accountId ||
    result.authGeneration !== current.authGeneration
  ) {
    return false;
  }
  if (current.status === "managed") return true;
  usePolicyStore.setState({
    status: "error",
    managed: false,
    policy: null,
  });
  return true;
}

function ensurePolicyLifecycleListeners(): void {
  if (lifecycleListenersReady) return;
  lifecycleListenersReady = true;
  window.electronAPI.onWorkspacePolicyChanged?.((snapshot) => {
    if (!snapshot.success) {
      applyPolicyFailure(snapshot);
      return;
    }
    void readAppVersion().then((appVersion) => applyPolicySnapshot(snapshot, appVersion));
  });
  const refreshResolvedPolicy = (): void => {
    const state = usePolicyStore.getState();
    const identity = resolvedPolicyRefreshIdentity(state);
    if (!identity) return;
    void state.fetchPolicy(identity.accountId, identity.authGeneration);
  };
  window.addEventListener("online", refreshResolvedPolicy);
  window.addEventListener("focus", refreshResolvedPolicy);
  window.setInterval(refreshResolvedPolicy, POLICY_SUCCESS_REFRESH_MS);
}

export const usePolicyStore = create<PolicyState>()((set, get) => {
  const resetPolicy = (status: "idle" | "loading"): void => {
    fetchSequence += 1;
    fetchInFlight = null;
    set({
      accountId: null,
      authGeneration: null,
      revision: 0,
      status,
      managed: false,
      policy: null,
      appVersion: null,
    });
  };

  return {
    accountId: null,
    authGeneration: null,
    revision: 0,
    status: "idle",
    managed: false,
    policy: null,
    appVersion: null,
    fetchPolicy: (accountId: string, authGeneration: number): Promise<void> => {
      ensurePolicyLifecycleListeners();
      if (
        fetchInFlight?.accountId === accountId &&
        fetchInFlight.authGeneration === authGeneration
      ) {
        return fetchInFlight.promise;
      }

      const previous = get();
      const sameIdentity =
        previous.accountId === accountId && previous.authGeneration === authGeneration;
      const preserveResolvedPolicy =
        sameIdentity && (previous.status === "managed" || previous.status === "unmanaged");
      const sequence = ++fetchSequence;
      if (!preserveResolvedPolicy) {
        set({
          accountId,
          authGeneration,
          revision: sameIdentity ? previous.revision : 0,
          status: "loading",
          managed: false,
          policy: null,
          appVersion: null,
        });
      }

      const promise = (async () => {
        const versionPromise = readAppVersion();
        try {
          const result = await window.electronAPI.getWorkspacePolicy?.(accountId, authGeneration);
          const appVersion = await versionPromise;
          if (sequence !== fetchSequence) return;
          if (result?.success) {
            if (applyPolicySnapshot(result, appVersion)) return;
            throw new Error("Workspace policy response did not match the active credential");
          }
          throw Object.assign(new Error(result?.error || "Workspace policy is unavailable"), {
            code: result?.code,
          });
        } catch (error) {
          if (sequence !== fetchSequence) return;
          logger.error("Failed to fetch workspace policy:", error);
          const failureCode =
            error && typeof error === "object" && "code" in error && typeof error.code === "string"
              ? error.code
              : undefined;
          // Resolve the version before the staleness re-check: awaiting inside set()
          // would let a clearPolicy()/newer fetch land first and then be clobbered.
          const appVersion = await versionPromise;
          if (sequence !== fetchSequence) return;
          const current = get();
          if (!(
            current.accountId === accountId &&
            shouldPreserveResolvedPolicyOnFailure(current.status, failureCode)
          )) {
            set({
              accountId,
              status: "error",
              managed: false,
              policy: null,
              appVersion,
            });
          }
        } finally {
          if (
            fetchInFlight?.accountId === accountId &&
            fetchInFlight.authGeneration === authGeneration
          ) {
            fetchInFlight = null;
          }
        }
      })();

      fetchInFlight = { accountId, authGeneration, promise };
      return promise;
    },
    clearPolicy: (): void => resetPolicy("idle"),
    suspendPolicy: (): void => resetPolicy("loading"),
  };
});
