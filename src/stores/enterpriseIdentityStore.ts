import type { InferenceScope } from "../config/inferenceScopes";
import { create } from "zustand";
import {
  clearManagedEnterpriseIdentity,
  type ClearEnterpriseIdentityOptions,
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
  // Which audio operations the transcription entries above cover.
  managedAudioOperations: AudioOperations;
  enforcedAudioOperations: AudioOperations;
  refresh: (
    accountId: string,
    workspaceId: string,
    authGeneration: number,
    forceRefresh?: boolean
  ) => Promise<void>;
  clear: (options?: ClearEnterpriseIdentityOptions) => void;
}

type AudioOperation = "batch" | "realtime";
// null is unknown (state with no scopes, or a summary or report from a build
// that predates the split) and covers both operations.
type AudioOperations = AudioOperation[] | null;
type ScopeSummary = {
  managed: ManagedEnterpriseScope[];
  enforced: ManagedEnterpriseScope[];
  managedAudioOperations?: AudioOperation[];
  enforcedAudioOperations?: AudioOperation[];
};
const EMPTY_SCOPES: ScopeSummary = { managed: [], enforced: [] };

function audioOperationsOf(value: unknown): AudioOperations {
  return Array.isArray(value) ? (value as AudioOperation[]) : null;
}

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

/**
 * The managed setup a failed fetch keeps holding. A workspace the API says is
 * no longer Enterprise has none left, so routing returns to the user's own
 * setup; any other failure keeps the last known one so it still fails closed.
 */
function scopesHeldAfterError(
  code: unknown,
  config: ManagedEnterpriseConfig | null,
  accountId: string | null,
  workspaceId: string | null
): ScopeSummary {
  if (code === "ENTERPRISE_REQUIRED") {
    if (accountId && workspaceId) persistScopes(accountId, workspaceId, EMPTY_SCOPES);
    return EMPTY_SCOPES;
  }
  return config ? summarize(config) : readPersistedScopes(accountId, workspaceId);
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

/** The audio operations behind enforcedScopesOnError's transcription entry, from the same source. */
function enforcedAudioOperationsOnError(
  reportedScopes: unknown,
  reportedOperations: unknown,
  enforcementRequired: boolean | undefined,
  lastKnown: ScopeSummary
): AudioOperations {
  if (Array.isArray(reportedScopes)) return audioOperationsOf(reportedOperations);
  if (enforcementRequired === false) return [];
  return audioOperationsOf(lastKnown.enforcedAudioOperations);
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
  managedAudioOperations: null,
  enforcedAudioOperations: null,

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
      managedAudioOperations: sameIdentity ? current.managedAudioOperations : null,
      enforcedAudioOperations: sameIdentity ? current.enforcedAudioOperations : null,
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
              code: result.code,
              enforcementRequired: result.enforcementRequired,
              enforcedScopes: result.enforcedScopes,
              enforcedAudioOperations: (result as { enforcedAudioOperations?: unknown })
                .enforcedAudioOperations,
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
          managedAudioOperations: audioOperationsOf(summary.managedAudioOperations),
          enforcedAudioOperations: null,
        });
      } catch (error) {
        if (sequence !== requestSequence) return;
        const message = error instanceof Error ? error.message : String(error);
        const enforcementRequired = (error as { enforcementRequired?: boolean })
          .enforcementRequired;
        logger.warn("Managed enterprise AI configuration unavailable", { error: message }, "auth");
        // Another identity's config never stands in, even to fail closed.
        const lastKnown = scopesHeldAfterError(
          (error as { code?: unknown }).code,
          sameIdentity ? current.config : null,
          accountId,
          workspaceId
        );
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
          managedAudioOperations: audioOperationsOf(lastKnown.managedAudioOperations),
          enforcedAudioOperations: enforcedAudioOperationsOnError(
            (error as { enforcedScopes?: unknown }).enforcedScopes,
            (error as { enforcedAudioOperations?: unknown }).enforcedAudioOperations,
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

  clear: (options) => {
    requestSequence += 1;
    inFlightKey = null;
    inFlightPromise = null;
    clearManagedEnterpriseIdentity(options);
    set({
      accountId: null,
      workspaceId: null,
      authGeneration: null,
      status: "idle",
      config: null,
      error: null,
      managedScopes: [],
      enforcedScopes: [],
      managedAudioOperations: null,
      enforcedAudioOperations: null,
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
        managedAudioOperations: audioOperationsOf(summary.managedAudioOperations),
        enforcedAudioOperations: null,
      });
      return;
    }
    const lastKnown = scopesHeldAfterError(
      snapshot.code,
      state.config,
      state.accountId,
      state.workspaceId
    );
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
      managedAudioOperations: audioOperationsOf(lastKnown.managedAudioOperations),
      enforcedAudioOperations: enforcedAudioOperationsOnError(
        snapshot.enforcedScopes,
        snapshot.enforcedAudioOperations,
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
  scopeHold: false | "unavailable" | "loading",
  operation: "batch" | "realtime" = "batch"
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
    setupMode,
    operation
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
    | "status"
    | "config"
    | "accountId"
    | "workspaceId"
    | "managedScopes"
    | "enforcedScopes"
    | "managedAudioOperations"
    | "enforcedAudioOperations"
  >,
  requestedScope: ManagedEnterpriseScope,
  setupMode: EnterpriseSetupMode,
  operation: AudioOperation = "batch"
): false | "unavailable" | "loading" {
  const scope = MANAGED_SCOPE_ALIASES[requestedScope] ?? requestedScope;
  // A required batch-only workspace never claimed meetings, so its hold leaves realtime alone.
  const covers = (operations: AudioOperations | undefined): boolean =>
    scope !== "transcription" || !Array.isArray(operations) || operations.includes(operation);
  if ((state.status === "idle" || state.status === "loading") && !state.config) {
    // Covers both the very first fetch for an identity ("idle", right after
    // app start or a workspace switch, before refresh() has even been
    // called) and a retry after an error ("loading" with in-memory
    // enforcement carried forward). Prefer that in-memory enforcement; fall
    // back to the persisted cold-start hint only when nothing was carried
    // forward yet. After clear() there is no accountId/workspaceId, so the
    // hint lookup finds nothing and a signed-out user is never held.
    const hint = state.enforcedScopes.length
      ? { enforced: state.enforcedScopes, enforcedAudioOperations: state.enforcedAudioOperations }
      : readPersistedScopes(state.accountId, state.workspaceId);
    return hint.enforced.includes(scope) && covers(hint.enforcedAudioOperations)
      ? "loading"
      : false;
  }
  if (state.enforcedScopes.includes(scope) && covers(state.enforcedAudioOperations))
    return "unavailable";
  if (
    setupMode === "managed" &&
    state.status === "error" &&
    state.managedScopes.includes(scope) &&
    covers(state.managedAudioOperations)
  ) {
    return "unavailable";
  }
  return false;
}

type TextScopeResolution =
  | Exclude<ManagedEnterpriseScopeResolution, { kind: "managed" }>
  | (Extract<ManagedEnterpriseScopeResolution, { kind: "managed" }> & {
      provider: "bedrock" | "azure";
    });

/** Imperative reads (services, stores). Components should use useManagedScopeResolution. */
export function getManagedScopeResolution(
  scope: InferenceScope,
  setupMode: EnterpriseSetupMode
): TextScopeResolution;
export function getManagedScopeResolution(
  scope: ManagedEnterpriseScope,
  setupMode: EnterpriseSetupMode,
  operation?: "batch" | "realtime"
): ManagedEnterpriseScopeResolution;
export function getManagedScopeResolution(
  scope: ManagedEnterpriseScope,
  setupMode: EnterpriseSetupMode,
  operation: "batch" | "realtime" = "batch"
): ManagedEnterpriseScopeResolution {
  const state = useEnterpriseIdentityStore.getState();
  return resolveScope(
    state.config,
    scope,
    setupMode,
    scopeFailsClosed(state, scope, setupMode, operation),
    operation
  );
}

/** Subscribes to the managed config so the UI re-renders when an administrator changes it. */
export function useManagedScopeResolution(
  scope: InferenceScope,
  setupMode: EnterpriseSetupMode
): TextScopeResolution;
export function useManagedScopeResolution(
  scope: ManagedEnterpriseScope,
  setupMode: EnterpriseSetupMode,
  operation?: "batch" | "realtime"
): ManagedEnterpriseScopeResolution;
export function useManagedScopeResolution(
  scope: ManagedEnterpriseScope,
  setupMode: EnterpriseSetupMode,
  operation: "batch" | "realtime" = "batch"
): ManagedEnterpriseScopeResolution {
  const config = useEnterpriseIdentityStore((state) => state.config);
  const scopeHold = useEnterpriseIdentityStore((state) =>
    scopeFailsClosed(state, scope, setupMode, operation)
  );
  return resolveScope(config, scope, setupMode, scopeHold, operation);
}
