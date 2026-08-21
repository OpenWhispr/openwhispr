import { create } from "zustand";
import {
  clearManagedEnterpriseIdentity,
  getManagedEnterpriseConfig,
  type ManagedEnterpriseConfigResult,
} from "../services/EnterpriseIdentityService";
import type {
  EnterpriseSetupMode,
  ManagedEnterpriseConfig,
  ManagedEnterpriseLocalModelSelection,
  ManagedEnterpriseLocalModels,
  ManagedEnterpriseScopeResolution,
} from "../types/enterpriseIdentity";
import type { InferenceScope } from "../config/inferenceScopes";
import logger from "../utils/logger";
import {
  isValidManagedEnterpriseLocalModels,
  resolveManagedEnterpriseScope,
} from "../helpers/enterpriseManagedConfig.mjs";
import {
  readManagedLocalModelPolicySnapshot,
  writeManagedLocalModelPolicySnapshot,
} from "../helpers/managedLocalModelPolicyCache";
import { isLlmSelectionAllowed, isModeAllowedByPolicy } from "./policyRules";
import { usePolicyStore } from "./policyStore";
import {
  resolveManagedLocalModelLockSnapshot,
  type ManagedLocalModelCategory,
} from "../components/onboarding/managedLocalModels";

export interface EnterpriseIdentityState {
  accountId: string | null;
  workspaceId: string | null;
  authGeneration: number | null;
  status: "idle" | "loading" | "ready" | "error";
  config: ManagedEnterpriseConfig | null;
  lastKnownLocalModels: ManagedEnterpriseLocalModels | null;
  lastKnownLocalModelsKnown: boolean;
  lastKnownManagedInferenceConfigured: boolean | null;
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

const STABLE_ENTERPRISE_IDENTITY_ERROR_CODES = new Set([
  "AUTH_EXPIRED",
  "AUTH_CONTEXT_CHANGED",
  "AUTH_CONTEXT_UNVALIDATED",
  "ENTERPRISE_REQUIRED",
  "MANAGED_WORKSPACE_REQUIRED",
  "SSO_REQUIRED",
  "DIRECTORY_ASSIGNMENT_REQUIRED",
  "PROVIDER_NOT_ALLOWED",
  "PROVIDER_NOT_CONFIGURED",
  "POLICY_UNRESOLVABLE",
  "MANAGED_CONFIG_INVALID",
  "MANAGED_CONFIG_UNAVAILABLE",
  "MANAGED_ENTERPRISE_UNSUPPORTED",
]);

function createEnterpriseIdentityError(
  result: ManagedEnterpriseConfigResult
): Error & { code: string; enforcementRequired?: boolean } {
  const code = result.code || "MANAGED_CONFIG_UNAVAILABLE";
  const dynamicMessage = result.error?.trim();
  const message =
    STABLE_ENTERPRISE_IDENTITY_ERROR_CODES.has(code) || !dynamicMessage ? code : dynamicMessage;
  return Object.assign(new Error(message), {
    code,
    enforcementRequired: result.enforcementRequired,
  });
}

function validatedLocalModels(
  config: ManagedEnterpriseConfig | null
): ManagedEnterpriseLocalModels | null {
  const localModels = config?.localModels ?? null;
  if (localModels !== null && !isValidManagedEnterpriseLocalModels(localModels)) {
    throw Object.assign(new Error("MANAGED_CONFIG_INVALID"), {
      code: "MANAGED_CONFIG_INVALID",
    });
  }
  return localModels;
}

function hasManagedInferenceConfiguration(config: ManagedEnterpriseConfig | null): boolean {
  if (!config) return false;
  return (
    config.localModels !== null || config.providers.some((provider) => provider.mode !== "disabled")
  );
}

export const useEnterpriseIdentityStore = create<EnterpriseIdentityState>((set, get) => ({
  accountId: null,
  workspaceId: null,
  authGeneration: null,
  status: "idle",
  config: null,
  lastKnownLocalModels: null,
  lastKnownLocalModelsKnown: false,
  lastKnownManagedInferenceConfigured: null,
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
    const persistedSnapshot = sameIdentity
      ? null
      : readManagedLocalModelPolicySnapshot(accountId, workspaceId);
    const priorLocalModels = sameIdentity
      ? current.lastKnownLocalModels
      : (persistedSnapshot?.localModels ?? null);
    const priorLocalModelsKnown = sameIdentity
      ? current.lastKnownLocalModelsKnown
      : persistedSnapshot !== null;
    const priorManagedInferenceConfigured = sameIdentity
      ? current.lastKnownManagedInferenceConfigured
      : (persistedSnapshot?.managedInferenceConfigured ?? null);
    set({
      accountId,
      workspaceId,
      authGeneration,
      status: sameIdentity && current.config ? "ready" : "loading",
      config: sameIdentity ? current.config : null,
      lastKnownLocalModels: priorLocalModels,
      lastKnownLocalModelsKnown: priorLocalModelsKnown,
      lastKnownManagedInferenceConfigured: priorManagedInferenceConfigured,
      error: null,
      failClosed: sameIdentity
        ? current.failClosed
        : (persistedSnapshot?.managedInferenceConfigured ?? true),
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
          throw createEnterpriseIdentityError(result);
        }
        const localModels = validatedLocalModels(result.config ?? null);
        const managedInferenceConfigured = hasManagedInferenceConfiguration(result.config ?? null);
        writeManagedLocalModelPolicySnapshot(
          accountId,
          workspaceId,
          localModels,
          managedInferenceConfigured
        );
        set({
          status: "ready",
          config: result.config ?? null,
          lastKnownLocalModels: localModels,
          lastKnownLocalModelsKnown: true,
          lastKnownManagedInferenceConfigured: managedInferenceConfigured,
          error: null,
          failClosed: false,
        });
      } catch (error) {
        if (sequence !== requestSequence) return;
        const message = error instanceof Error ? error.message : String(error);
        const enforcementRequired = (error as { enforcementRequired?: boolean })
          .enforcementRequired;
        const failClosed = typeof enforcementRequired === "boolean" ? enforcementRequired : true;
        if (enforcementRequired === false) {
          writeManagedLocalModelPolicySnapshot(accountId, workspaceId, null, false);
        }
        logger.warn("Managed enterprise AI configuration unavailable", { error: message }, "auth");
        set({
          status: "error",
          config: null,
          lastKnownLocalModels: failClosed ? priorLocalModels : null,
          lastKnownLocalModelsKnown: failClosed
            ? priorLocalModelsKnown
            : enforcementRequired === false,
          lastKnownManagedInferenceConfigured: failClosed ? priorManagedInferenceConfigured : false,
          error: message,
          failClosed,
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
      lastKnownLocalModels: null,
      lastKnownLocalModelsKnown: false,
      lastKnownManagedInferenceConfigured: null,
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
    const failClosed = snapshot.config
      ? false
      : typeof snapshot.enforcementRequired === "boolean"
        ? snapshot.enforcementRequired
        : true;
    let localModels = state.lastKnownLocalModels;
    let localModelsKnown = state.lastKnownLocalModelsKnown;
    let managedInferenceConfigured = state.lastKnownManagedInferenceConfigured;
    if (snapshot.config) {
      try {
        localModels = validatedLocalModels(snapshot.config);
        localModelsKnown = true;
        managedInferenceConfigured = hasManagedInferenceConfiguration(snapshot.config);
        writeManagedLocalModelPolicySnapshot(
          state.accountId,
          state.workspaceId,
          localModels,
          managedInferenceConfigured
        );
      } catch (error) {
        logger.warn(
          "Managed enterprise local model configuration is invalid",
          { error: error instanceof Error ? error.message : String(error) },
          "auth"
        );
        useEnterpriseIdentityStore.setState({
          status: "error",
          config: null,
          error: "MANAGED_CONFIG_INVALID",
          failClosed: true,
        });
        return;
      }
    } else if (!failClosed) {
      localModels = null;
      localModelsKnown = true;
      managedInferenceConfigured = false;
      writeManagedLocalModelPolicySnapshot(state.accountId, state.workspaceId, null, false);
    }
    useEnterpriseIdentityStore.setState({
      status: snapshot.config ? "ready" : "error",
      config: snapshot.config,
      lastKnownLocalModels: localModels,
      lastKnownLocalModelsKnown: localModelsKnown,
      lastKnownManagedInferenceConfigured: managedInferenceConfigured,
      error: snapshot.config ? null : snapshot.code,
      failClosed,
    });
  });
}

export function selectEffectiveManagedLocalModels(
  state: EnterpriseIdentityState
): ManagedEnterpriseLocalModels | null {
  return state.config?.localModels ?? (state.failClosed ? state.lastKnownLocalModels : null);
}

export function isManagedLocalModelCategoryRequired(
  category: "transcription" | "reasoning"
): boolean {
  const state = useEnterpriseIdentityStore.getState();
  if (!state.accountId || !state.workspaceId) return false;
  const approved = selectEffectiveManagedLocalModels(state)?.[category] ?? [];
  return approved.length > 0 || (state.failClosed && !state.lastKnownLocalModelsKnown);
}

export function getManagedLocalModelRuntimeLock(category: ManagedLocalModelCategory): {
  managed: boolean;
  selection: ManagedEnterpriseLocalModelSelection | null;
} {
  const state = useEnterpriseIdentityStore.getState();
  return resolveManagedLocalModelLockSnapshot(
    {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      localModels: selectEffectiveManagedLocalModels(state),
      localModelsKnown: state.lastKnownLocalModelsKnown,
      failClosed: state.failClosed,
    },
    category
  );
}

export function getApprovedFailClosedManagedLocalReasoning(
  provider: string | null | undefined,
  modelId: string | null | undefined
): ManagedEnterpriseLocalModelSelection | null {
  const state = useEnterpriseIdentityStore.getState();
  if (
    state.config ||
    !state.failClosed ||
    !state.lastKnownLocalModelsKnown ||
    !isModeAllowedByPolicy(usePolicyStore.getState(), "llm", "local") ||
    !provider ||
    !modelId
  ) {
    return null;
  }
  return (
    state.lastKnownLocalModels?.reasoning.find(
      (selection) => selection.provider === provider && selection.modelId === modelId
    ) ?? null
  );
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
