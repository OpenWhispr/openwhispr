import { create } from "zustand";
import {
  clearManagedEnterpriseIdentity,
  getManagedEnterpriseConfig,
} from "../services/EnterpriseIdentityService";
import type {
  EnterpriseSetupMode,
  ManagedEnterpriseConfig,
  ManagedEnterpriseScope,
  ManagedEnterpriseScopeResolution,
} from "../types/enterpriseIdentity";
import logger from "../utils/logger";
import {
  resolveManagedEnterpriseScope,
  managedScopesForConfig,
} from "../helpers/enterpriseManagedConfig.mjs";
import { isLlmSelectionAllowed, isTranscriptionSelectionAllowed } from "./policyRules";
import { usePolicyStore } from "./policyStore";

interface EnterpriseIdentityState {
  accountId: string | null;
  workspaceId: string | null;
  authGeneration: number | null;
  status: "idle" | "loading" | "ready" | "error";
  config: ManagedEnterpriseConfig | null;
  error: string | null;
  managedScopes: ManagedEnterpriseScope[];
  enforcedScopes: ManagedEnterpriseScope[];
  refresh: (
    accountId: string,
    workspaceId: string,
    authGeneration: number,
    forceRefresh?: boolean
  ) => Promise<void>;
  clear: () => void;
}

type ScopeSummary = { managed: ManagedEnterpriseScope[]; enforced: ManagedEnterpriseScope[] };
const EMPTY_SCOPES: ScopeSummary = { managed: [], enforced: [] };

function scopeStorageKey(accountId: string | null, workspaceId: string | null): string | null {
  return accountId && workspaceId ? `managedEnterpriseScopes:${accountId}:${workspaceId}` : null;
}

function readPersistedScopes(accountId: string | null, workspaceId: string | null): ScopeSummary {
  const key = scopeStorageKey(accountId, workspaceId);
  if (!key || typeof localStorage === "undefined") return EMPTY_SCOPES;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(parsed?.managed) && Array.isArray(parsed?.enforced)
      ? parsed
      : EMPTY_SCOPES;
  } catch {
    return EMPTY_SCOPES;
  }
}

function persistScopes(accountId: string, workspaceId: string, summary: ScopeSummary): void {
  const key = scopeStorageKey(accountId, workspaceId);
  if (!key || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(summary));
  } catch {
    // Storage is a cold-start hint only.
  }
}

function summarize(config: ManagedEnterpriseConfig | null): ScopeSummary {
  return managedScopesForConfig(config) as ScopeSummary;
}

/** Scopes that must fail closed when the config is gone: the main process's list, else the last known one. */
function enforcedScopesOnError(
  reported: unknown,
  enforcementRequired: boolean | undefined,
  lastKnown: ScopeSummary
): ManagedEnterpriseScope[] {
  if (Array.isArray(reported)) return reported as ManagedEnterpriseScope[];
  if (enforcementRequired === false) return [];
  return lastKnown.enforced;
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
  managedScopes: [],
  enforcedScopes: [],

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
      managedScopes: sameIdentity ? current.managedScopes : [],
      enforcedScopes: sameIdentity ? current.enforcedScopes : [],
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
            {
              enforcementRequired: result.enforcementRequired,
              enforcedScopes: result.enforcedScopes,
            }
          );
        }
        const summary = summarize(result.config ?? null);
        persistScopes(accountId, workspaceId, summary);
        set({
          status: "ready",
          config: result.config ?? null,
          error: null,
          managedScopes: summary.managed,
          enforcedScopes: [],
        });
      } catch (error) {
        if (sequence !== requestSequence) return;
        const message = error instanceof Error ? error.message : String(error);
        const enforcementRequired = (error as { enforcementRequired?: boolean })
          .enforcementRequired;
        logger.warn("Managed enterprise AI configuration unavailable", { error: message }, "auth");
        const lastKnown = current.config
          ? summarize(current.config)
          : readPersistedScopes(accountId, workspaceId);
        set({
          status: "error",
          config: null,
          error: message,
          managedScopes: lastKnown.managed,
          enforcedScopes: enforcedScopesOnError(
            (error as { enforcedScopes?: unknown }).enforcedScopes,
            enforcementRequired,
            lastKnown
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
      managedScopes: [],
      enforcedScopes: [],
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
    if (snapshot.config) {
      const summary = summarize(snapshot.config);
      if (state.accountId && state.workspaceId) {
        persistScopes(state.accountId, state.workspaceId, summary);
      }
      useEnterpriseIdentityStore.setState({
        status: "ready",
        config: snapshot.config,
        error: null,
        managedScopes: summary.managed,
        enforcedScopes: [],
      });
      return;
    }
    const lastKnown = state.config
      ? summarize(state.config)
      : readPersistedScopes(state.accountId, state.workspaceId);
    useEnterpriseIdentityStore.setState({
      status: "error",
      config: null,
      error: snapshot.code,
      managedScopes: lastKnown.managed,
      enforcedScopes: enforcedScopesOnError(
        snapshot.enforcedScopes,
        snapshot.enforcementRequired,
        lastKnown
      ),
    });
  });
}

// The vision override is the dictation agent's image lane; it has no managed
// scope of its own (enterprise envelopes predate it), so managed resolution
// follows the agent scope instead of failing as an unknown scope.
const MANAGED_SCOPE_ALIASES: Partial<Record<ManagedEnterpriseScope, ManagedEnterpriseScope>> = {
  dictationAgentVision: "dictationAgent",
};

function isManagedSelectionAllowedByPolicy(
  scope: ManagedEnterpriseScope,
  provider: string
): boolean {
  const policy = usePolicyStore.getState();
  const selection = { mode: "enterprise" as const, provider };
  return scope === "transcription"
    ? isTranscriptionSelectionAllowed(policy, selection)
    : isLlmSelectionAllowed(policy, selection);
}

function resolveScope(
  config: ManagedEnterpriseConfig | null,
  requestedScope: ManagedEnterpriseScope,
  setupMode: EnterpriseSetupMode,
  scopeHold: false | "unavailable" | "loading"
): ManagedEnterpriseScopeResolution {
  const scope = MANAGED_SCOPE_ALIASES[requestedScope] ?? requestedScope;
  if (!config && scopeHold) {
    return scopeHold === "loading"
      ? {
          kind: "error",
          code: "MANAGED_CONFIG_LOADING",
          message: "Checking your organization's managed setup. Try again in a moment.",
          messageKey: "common.managedConfigLoading",
        }
      : {
          kind: "error",
          code: "MANAGED_CONFIG_UNAVAILABLE",
          message:
            "Managed enterprise access is unavailable. Sign in again or contact your IT administrator.",
          messageKey: "common.managedConfigUnavailable",
        };
  }
  const resolution = resolveManagedEnterpriseScope(
    config,
    scope,
    setupMode
  ) as ManagedEnterpriseScopeResolution;
  if (
    resolution.kind === "managed" &&
    !isManagedSelectionAllowedByPolicy(scope, resolution.provider)
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
          messageKey: "common.managedPolicyConflict",
        }
      : { kind: "manual" };
  }
  return resolution;
}

/**
 * Per-scope fail-closed decision. `"loading"` only while the first fetch for
 * this identity is still pending and the last-known config enforced the
 * scope; `"unavailable"` once the config is confirmed gone (error) and either
 * the main process reported this scope enforced or, in managed setup mode,
 * the scope was ever managed for this workspace. Otherwise `false`, so an
 * unrelated scope (e.g. transcription on an LLM-only workspace) never fails
 * closed just because another scope's config outage occurred.
 */
function scopeFailsClosed(
  state: Pick<
    EnterpriseIdentityState,
    "status" | "config" | "accountId" | "workspaceId" | "managedScopes" | "enforcedScopes"
  >,
  requestedScope: ManagedEnterpriseScope,
  setupMode: EnterpriseSetupMode
): false | "unavailable" | "loading" {
  const scope = MANAGED_SCOPE_ALIASES[requestedScope] ?? requestedScope;
  if ((state.status === "idle" || state.status === "loading") && !state.config) {
    // Covers both the very first fetch for an identity ("idle", right after
    // app start or a workspace switch, before refresh() has even been
    // called) and a retry after an error ("loading" with in-memory
    // enforcement carried forward). Prefer that in-memory enforcement; fall
    // back to the persisted cold-start hint only when nothing was carried
    // forward yet. After clear() there is no accountId/workspaceId, so the
    // hint lookup finds nothing and a signed-out user is never held.
    const enforced = state.enforcedScopes.length
      ? state.enforcedScopes
      : readPersistedScopes(state.accountId, state.workspaceId).enforced;
    return enforced.includes(scope) ? "loading" : false;
  }
  if (state.enforcedScopes.includes(scope)) return "unavailable";
  if (setupMode === "managed" && state.status === "error" && state.managedScopes.includes(scope)) {
    return "unavailable";
  }
  return false;
}

/** Imperative reads (services, stores). Components should use useManagedScopeResolution. */
export function getManagedScopeResolution(
  scope: ManagedEnterpriseScope,
  setupMode: EnterpriseSetupMode
): ManagedEnterpriseScopeResolution {
  const state = useEnterpriseIdentityStore.getState();
  return resolveScope(state.config, scope, setupMode, scopeFailsClosed(state, scope, setupMode));
}

/** Subscribes to the managed config so the UI re-renders when an administrator changes it. */
export function useManagedScopeResolution(
  scope: ManagedEnterpriseScope,
  setupMode: EnterpriseSetupMode
): ManagedEnterpriseScopeResolution {
  const config = useEnterpriseIdentityStore((state) => state.config);
  const scopeHold = useEnterpriseIdentityStore((state) =>
    scopeFailsClosed(state, scope, setupMode)
  );
  return resolveScope(config, scope, setupMode, scopeHold);
}
