import { create } from "zustand";
import {
  clearManagedEnterpriseIdentity,
  getManagedEnterpriseConfig,
} from "../services/EnterpriseIdentityService";
import type {
  EnterpriseSetupMode,
  ManagedEnterpriseConfig,
  ManagedEnterpriseScopeResolution,
} from "../types/enterpriseIdentity";
import type { InferenceScope } from "../config/inferenceScopes";
import logger from "../utils/logger";
import { resolveManagedEnterpriseScope } from "../helpers/enterpriseManagedConfig.mjs";
import { isLlmSelectionAllowed } from "./policyRules";
import { usePolicyStore } from "./policyStore";

interface EnterpriseIdentityState {
  accountId: string | null;
  workspaceId: string | null;
  authGeneration: number | null;
  status: "idle" | "loading" | "ready" | "error";
  config: ManagedEnterpriseConfig | null;
  error: string | null;
  failClosed: boolean;
  refresh: (
    accountId: string,
    workspaceId: string,
    authGeneration: number,
    forceRefresh?: boolean
  ) => Promise<void>;
  clear: () => void;
}

let requestSequence = 0;
let inFlightKey: string | null = null;
let inFlightPromise: Promise<void> | null = null;
let lifecycleListenersReady = false;

export const useEnterpriseIdentityStore = create<EnterpriseIdentityState>((set, get) => ({
  accountId: null,
  workspaceId: null,
  authGeneration: null,
  status: "idle",
  config: null,
  error: null,
  failClosed: false,

  refresh: (accountId, workspaceId, authGeneration, forceRefresh = false) => {
    ensureLifecycleListeners();
    const key = `${accountId}:${workspaceId}:${authGeneration}:${forceRefresh ? "force" : "normal"}`;
    if (inFlightKey === key && inFlightPromise) return inFlightPromise;
    const sequence = ++requestSequence;
    const current = get();
    const sameIdentity =
      current.accountId === accountId &&
      current.workspaceId === workspaceId &&
      current.authGeneration === authGeneration;
    set({
      accountId,
      workspaceId,
      authGeneration,
      status: sameIdentity && current.config ? "ready" : "loading",
      config: sameIdentity ? current.config : null,
      error: null,
      failClosed: sameIdentity ? current.failClosed : false,
    });

    const promise = (async () => {
      try {
        const result = await getManagedEnterpriseConfig(
          accountId,
          workspaceId,
          authGeneration,
          forceRefresh
        );
        if (sequence !== requestSequence) return;
        if (
          !result.success ||
          result.accountId !== accountId ||
          result.workspaceId !== workspaceId ||
          result.authGeneration !== authGeneration
        ) {
          throw Object.assign(
            new Error(result.error || "Managed enterprise AI configuration is unavailable."),
            { enforcementRequired: result.enforcementRequired }
          );
        }
        set({
          status: "ready",
          config: result.config ?? null,
          error: null,
          failClosed: false,
        });
      } catch (error) {
        if (sequence !== requestSequence) return;
        const message = error instanceof Error ? error.message : String(error);
        const enforcementRequired = (error as { enforcementRequired?: boolean })
          .enforcementRequired;
        logger.warn("Managed enterprise AI configuration unavailable", { error: message }, "auth");
        set({
          status: "error",
          config: null,
          error: message,
          failClosed:
            typeof enforcementRequired === "boolean"
              ? enforcementRequired
              : current.failClosed ||
                Boolean(
                  current.config?.providers.some(
                    (record) =>
                      record.mode !== "disabled" &&
                      (record.mode === "managed_required" || !record.allowManualSetup)
                  )
                ),
        });
      } finally {
        if (inFlightKey === key) {
          inFlightKey = null;
          inFlightPromise = null;
        }
      }
    })();
    inFlightKey = key;
    inFlightPromise = promise;
    return promise;
  },

  clear: () => {
    requestSequence += 1;
    inFlightKey = null;
    inFlightPromise = null;
    clearManagedEnterpriseIdentity();
    set({
      accountId: null,
      workspaceId: null,
      authGeneration: null,
      status: "idle",
      config: null,
      error: null,
      failClosed: false,
    });
  },
}));

function refreshCurrentManagedIdentity(): void {
  const state = useEnterpriseIdentityStore.getState();
  if (!state.accountId || !state.workspaceId || state.authGeneration == null) return;
  void state.refresh(state.accountId, state.workspaceId, state.authGeneration, true);
}

// Bound on first refresh() rather than at module load: the listeners no-op
// until an identity is resolved, and test harnesses import this store with
// partial window stubs that lack setInterval (same pattern as
// ensurePolicyLifecycleListeners in policyStore).
function ensureLifecycleListeners(): void {
  if (lifecycleListenersReady || typeof window === "undefined") return;
  lifecycleListenersReady = true;
  window.addEventListener("focus", refreshCurrentManagedIdentity);
  window.setInterval(refreshCurrentManagedIdentity, 5 * 60 * 1000);
  window.electronAPI?.onManagedEnterpriseConfigChanged?.((snapshot) => {
    const state = useEnterpriseIdentityStore.getState();
    if (
      snapshot.accountId !== state.accountId ||
      snapshot.workspaceId !== state.workspaceId ||
      snapshot.authGeneration !== state.authGeneration
    ) {
      return;
    }
    const currentGeneration = state.config?.generation ?? -1;
    if (snapshot.config && snapshot.config.generation < currentGeneration) return;
    useEnterpriseIdentityStore.setState({
      status: snapshot.config ? "ready" : "error",
      config: snapshot.config,
      error: snapshot.config ? null : snapshot.code,
      failClosed: snapshot.config
        ? false
        : typeof snapshot.enforcementRequired === "boolean"
          ? snapshot.enforcementRequired
          : state.failClosed ||
            Boolean(
              state.config?.providers.some(
                (record) =>
                  record.mode !== "disabled" &&
                  (record.mode === "managed_required" || !record.allowManualSetup)
              )
            ),
    });
  });
}

// The vision override is the dictation agent's image lane; it has no managed
// scope of its own (enterprise envelopes predate it), so managed resolution
// follows the agent scope instead of failing as an unknown scope.
const MANAGED_SCOPE_ALIASES: Partial<Record<InferenceScope, InferenceScope>> = {
  dictationAgentVision: "dictationAgent",
};

function resolveScope(
  config: ManagedEnterpriseConfig | null,
  requestedScope: InferenceScope,
  setupMode: EnterpriseSetupMode,
  failClosed: boolean
): ManagedEnterpriseScopeResolution {
  const scope = MANAGED_SCOPE_ALIASES[requestedScope] ?? requestedScope;
  if (!config && failClosed) {
    return {
      kind: "error",
      code: "MANAGED_CONFIG_UNAVAILABLE",
      message: "Managed enterprise access is unavailable. Sign in with company SSO or contact IT.",
    };
  }
  const resolution = resolveManagedEnterpriseScope(
    config,
    scope,
    setupMode
  ) as ManagedEnterpriseScopeResolution;
  if (
    resolution.kind === "managed" &&
    !isLlmSelectionAllowed(usePolicyStore.getState(), {
      mode: "enterprise",
      provider: resolution.provider,
    })
  ) {
    const required = resolution.mode === "managed_required" || !resolution.allowManualSetup;
    logger.warn("Managed enterprise provider is blocked by workspace policy", {
      provider: resolution.provider,
      scope,
      required,
    });
    return required
      ? {
          kind: "error",
          code: "PROVIDER_POLICY_CONFLICT",
          message:
            "Managed access is blocked by your workspace policy. Contact your IT administrator.",
        }
      : { kind: "manual" };
  }
  return resolution;
}

/** Imperative reads (services, stores). Components should use useManagedScopeResolution. */
export function getManagedScopeResolution(
  scope: InferenceScope,
  setupMode: EnterpriseSetupMode
): ManagedEnterpriseScopeResolution {
  const state = useEnterpriseIdentityStore.getState();
  return resolveScope(
    state.config,
    scope,
    setupMode,
    state.failClosed || (setupMode === "managed" && state.status === "error")
  );
}

/** Subscribes to the managed config so the UI re-renders when an administrator changes it. */
export function useManagedScopeResolution(
  scope: InferenceScope,
  setupMode: EnterpriseSetupMode
): ManagedEnterpriseScopeResolution {
  const config = useEnterpriseIdentityStore((state) => state.config);
  const failClosed = useEnterpriseIdentityStore(
    (state) => state.failClosed || (setupMode === "managed" && state.status === "error")
  );
  return resolveScope(config, scope, setupMode, failClosed);
}
