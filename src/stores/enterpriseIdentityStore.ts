import { create } from "zustand";
import {
  clearManagedEnterpriseIdentity,
  getManagedEnterpriseConfig,
} from "../services/EnterpriseIdentityService";
import type {
  EnterpriseSetupMode,
  ManagedEnterpriseConfig,
  ManagedEnterpriseLocalModels,
  ManagedEnterpriseScopeResolution,
} from "../types/enterpriseIdentity";
import type { InferenceScope } from "../config/inferenceScopes";
import logger from "../utils/logger";
import { resolveManagedEnterpriseScope } from "../helpers/enterpriseManagedConfig.mjs";
import { isLlmSelectionAllowed } from "./policyRules";
import { usePolicyStore } from "./policyStore";

export interface EnterpriseIdentityState {
  accountId: string | null;
  workspaceId: string | null;
  authGeneration: number | null;
  status: "idle" | "loading" | "ready" | "error";
  config: ManagedEnterpriseConfig | null;
  verdict: "unknown" | "configured" | "unmanaged";
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

export function isEnterpriseIdentitySettled(
  status: EnterpriseIdentityState["status"],
  verdict: EnterpriseIdentityState["verdict"]
): boolean {
  return (
    (status === "ready" && verdict === "configured") ||
    (status === "error" && verdict === "unmanaged")
  );
}

export function shouldWaitForEnterpriseReadiness(
  isSignedIn: boolean,
  status: EnterpriseIdentityState["status"],
  verdict: EnterpriseIdentityState["verdict"] = "unknown"
): boolean {
  return isSignedIn && !isEnterpriseIdentitySettled(status, verdict);
}

export interface ManagedLocalModelContext {
  identity: {
    accountId: string;
    workspaceId: string;
    authGeneration: number;
    configGeneration: number;
  };
  localModels: ManagedEnterpriseLocalModels;
}

export function selectManagedLocalModelContext(
  state: EnterpriseIdentityState
): ManagedLocalModelContext | null {
  if (
    state.status !== "ready" ||
    state.verdict !== "configured" ||
    !state.config?.localModels ||
    !state.accountId ||
    !state.workspaceId ||
    state.authGeneration == null
  ) {
    return null;
  }
  return {
    identity: {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      authGeneration: state.authGeneration,
      configGeneration: state.config.generation,
    },
    localModels: state.config.localModels,
  };
}

export const useEnterpriseIdentityStore = create<EnterpriseIdentityState>((set, get) => ({
  accountId: null,
  workspaceId: null,
  authGeneration: null,
  status: "idle",
  config: null,
  verdict: "unknown",
  error: null,
  failClosed: false,

  refresh: (accountId, workspaceId, authGeneration, forceRefresh = false) => {
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
      status: sameIdentity && current.verdict === "configured" ? "ready" : "loading",
      config: sameIdentity ? current.config : null,
      verdict: sameIdentity ? current.verdict : "unknown",
      error: null,
      failClosed: sameIdentity ? current.failClosed : true,
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
        const config = result.config ?? null;
        const unmanaged = config === null && result.enforcementRequired === false;
        if (!config && !unmanaged) {
          throw Object.assign(
            new Error(result.error || "Managed enterprise AI configuration is unavailable."),
            { enforcementRequired: result.enforcementRequired }
          );
        }
        set({
          status: unmanaged ? "error" : "ready",
          config,
          verdict: unmanaged ? "unmanaged" : "configured",
          error: unmanaged ? (result.code ?? null) : null,
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
          verdict: enforcementRequired === false ? "unmanaged" : "unknown",
          error: message,
          failClosed: enforcementRequired !== false,
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
      verdict: "unknown",
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

if (typeof window !== "undefined") {
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
      verdict: snapshot.config
        ? "configured"
        : snapshot.enforcementRequired === false
          ? "unmanaged"
          : "unknown",
      error: snapshot.config ? null : snapshot.code,
      failClosed: snapshot.config ? false : snapshot.enforcementRequired !== false,
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
