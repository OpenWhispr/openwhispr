import type { InferenceMode, ShareVisibility } from "../types/electron";
import type { OrgPolicy, PolicyScope } from "../types/policy";
import type { SettingsState } from "./settingsStore";
import { compareAppVersions } from "../utils/version.ts";
// The registry JSON directly (like policyValidation.js), NOT ModelRegistry:
// that module pulls the settings/identity stores, whose module scope needs
// real browser globals, and this file is imported by node-run sync tests.
import modelRegistryData from "../models/modelRegistryData.json" with { type: "json" };

export type PolicyStatus = "idle" | "loading" | "managed" | "unmanaged" | "error";

export interface PolicyDecisionSnapshot {
  status: PolicyStatus;
  policy: OrgPolicy | null;
  appVersion: string | null;
}

function managedPolicy(state: PolicyDecisionSnapshot): OrgPolicy | null {
  return state.status === "managed" && state.policy ? state.policy : null;
}

export function isPolicyActionAllowed(state: PolicyDecisionSnapshot): boolean {
  if (state.status === "idle" || state.status === "unmanaged") return true;
  if (state.status !== "managed" || !state.policy) return false;
  if (!state.policy.minAppVersion) return true;
  if (!state.appVersion) return false;
  return compareAppVersions(state.appVersion, state.policy.minAppVersion) >= 0;
}

/** Whether the org's minimum app version blocks this build (drives the update banner). */
export function isUpdateRequiredByOrg(state: PolicyDecisionSnapshot): boolean {
  const minAppVersion = managedPolicy(state)?.minAppVersion;
  if (!minAppVersion || !state.appVersion) return false;
  return compareAppVersions(state.appVersion, minAppVersion) < 0;
}

/** Fail closed while unresolved, allow unmanaged users, else ask the policy. */
function managedPolicyDecision(
  state: PolicyDecisionSnapshot,
  decide: (policy: OrgPolicy) => boolean
): boolean {
  if (!isPolicyActionAllowed(state)) return false;
  const policy = managedPolicy(state);
  return policy ? decide(policy) : true;
}

export function effectiveLocalHistoryEnabled(
  state: PolicyDecisionSnapshot,
  personalPreference: boolean
): boolean {
  return lockedLocalHistoryValue(state) ?? personalPreference;
}

/** The org-forced local history value, or null when the user may choose. */
export function lockedLocalHistoryValue(state: PolicyDecisionSnapshot): boolean | null {
  const mode = managedPolicy(state)?.dataRetention.localHistoryMode;
  if (mode === "always_on") return true;
  if (mode === "always_off") return false;
  return null;
}

export function effectiveAudioRetentionDays(
  state: PolicyDecisionSnapshot,
  personalPreference: number
): number {
  if (personalPreference === 0) return personalPreference;
  const maximumDays = maxAudioRetentionDays(state);
  return maximumDays === null ? personalPreference : Math.min(personalPreference, maximumDays);
}

/** The org cap on audio retention days, or null when uncapped. */
export function maxAudioRetentionDays(state: PolicyDecisionSnapshot): number | null {
  return managedPolicy(state)?.dataRetention.audioRetentionMaxDays ?? null;
}

/** Whether a transcription/LLM mode is allowed. Unmanaged users allow everything. */
export function isModeAllowedByPolicy(
  state: PolicyDecisionSnapshot,
  scope: PolicyScope,
  mode: InferenceMode
): boolean {
  return managedPolicyDecision(state, (policy) => policy[scope].allowedModes.includes(mode));
}

/** Whether a BYOK provider id is allowed for a scope. Unmanaged users allow everything. */
export function isProviderAllowedByPolicy(
  state: PolicyDecisionSnapshot,
  scope: PolicyScope,
  providerId: string
): boolean {
  return managedPolicyDecision(state, (policy) =>
    policy[scope].allowedByokProviders.includes(providerId)
  );
}

/** Whether an enterprise-cloud provider id is allowed. Unmanaged users allow everything. */
export function isEnterpriseProviderAllowed(
  state: PolicyDecisionSnapshot,
  providerId: string
): boolean {
  return managedPolicyDecision(state, (policy) =>
    policy.llm.allowedEnterpriseProviders.includes(providerId)
  );
}

/** Whether the AI agent (dictation, voice, and chat) is allowed. */
export function isAgentAllowed(state: PolicyDecisionSnapshot): boolean {
  return managedPolicyDecision(state, (policy) => policy.features.agentEnabled);
}

/** Whether the agent's web_search tool is allowed. */
export function isWebSearchAllowed(state: PolicyDecisionSnapshot): boolean {
  return managedPolicyDecision(state, (policy) => policy.features.webSearchEnabled);
}

/**
 * Whether the voice agent may attach screen context. Servers that predate the
 * field send none; absent means allowed.
 */
export function isScreenContextAllowed(state: PolicyDecisionSnapshot): boolean {
  return managedPolicyDecision(state, (policy) => policy.features.screenContextEnabled !== false);
}

const warnedUnknownRequiredModelIds = new Set<string>();

/**
 * Model ids the org requires on disk, filtered to ids this build's registry
 * knows how to download. Unknown ids (a newer server) are dropped with a
 * warning instead of failing the policy — minAppVersion is the enforcement
 * backstop. Fail-open for idle/loading/unmanaged/error: this field only ever
 * adds work for managed users, so an unresolved policy requires nothing yet.
 */
export function requiredLocalModelIds(state: PolicyDecisionSnapshot): string[] {
  const required = managedPolicy(state)?.requiredLocalModels;
  if (!required?.length) return [];
  const known = new Set<string>([
    ...Object.keys(modelRegistryData.whisperModels),
    ...Object.keys(modelRegistryData.parakeetModels),
  ]);
  const usable: string[] = [];
  for (const id of required) {
    if (known.has(id)) {
      if (!usable.includes(id)) usable.push(id);
    } else if (!warnedUnknownRequiredModelIds.has(id)) {
      warnedUnknownRequiredModelIds.add(id);
      console.warn(`[policy] Ignoring unknown required local model id: ${id}`);
    }
  }
  return usable;
}

/** Required ids not yet on disk. Disk truth (installed ids) comes from the caller. */
export function missingRequiredLocalModels(
  required: readonly string[],
  installedIds: readonly string[]
): string[] {
  const installed = new Set(installedIds);
  return required.filter((id) => !installed.has(id));
}

/** Whether cloud backup/sync is allowed. */
export function isCloudBackupAllowed(state: PolicyDecisionSnapshot): boolean {
  return managedPolicyDecision(state, (policy) => policy.dataRetention.cloudBackupAllowed);
}

/**
 * True only when a policy transition newly grants cloud backup, so sync
 * resumes once per grant instead of on every periodic policy refresh.
 */
export function cloudBackupResumed(
  previous: PolicyDecisionSnapshot,
  next: PolicyDecisionSnapshot
): boolean {
  return isCloudBackupAllowed(next) && !isCloudBackupAllowed(previous);
}

export interface LlmSelection {
  mode: InferenceMode;
  provider: string;
}

export interface PolicySelectionCatalog {
  modes: readonly InferenceMode[];
  byokProviders: readonly string[];
  enterpriseProviders?: readonly string[];
}

/**
 * Derive the selection used for future work without mutating the user's saved
 * preference. Managed users keep an allowed selection; stale selections use
 * the first usable choice in the same order as the settings UI.
 */
export function resolveEffectivePolicySelection(
  state: PolicyDecisionSnapshot,
  scope: PolicyScope,
  selection: LlmSelection,
  catalog: PolicySelectionCatalog
): LlmSelection | null {
  if (state.status === "idle" || state.status === "unmanaged") return selection;
  if (!isPolicyActionAllowed(state)) return null;
  const policy = managedPolicy(state);
  if (!policy) return null;

  const allowedByokProviders = catalog.byokProviders.filter((provider) =>
    policy[scope].allowedByokProviders.includes(provider)
  );
  const allowedEnterpriseProviders = (catalog.enterpriseProviders ?? []).filter((provider) =>
    policy.llm.allowedEnterpriseProviders.includes(provider)
  );
  const modeIsUsable = (mode: InferenceMode): boolean => {
    if (!catalog.modes.includes(mode)) return false;
    if (!policy[scope].allowedModes.includes(mode)) return false;
    if (mode === "providers") return allowedByokProviders.length > 0;
    if (mode === "enterprise") return scope === "llm" && allowedEnterpriseProviders.length > 0;
    return true;
  };

  const mode = modeIsUsable(selection.mode)
    ? selection.mode
    : (catalog.modes.find(modeIsUsable) ?? null);
  if (!mode) return null;

  if (mode === "providers") {
    return {
      mode,
      provider: allowedByokProviders.includes(selection.provider)
        ? selection.provider
        : allowedByokProviders[0],
    };
  }
  if (mode === "enterprise") {
    return {
      mode,
      provider: allowedEnterpriseProviders.includes(selection.provider)
        ? selection.provider
        : allowedEnterpriseProviders[0],
    };
  }
  return { mode, provider: selection.provider };
}

export function isLlmSelectionAllowed(
  state: PolicyDecisionSnapshot,
  selection: LlmSelection
): boolean {
  if (!isModeAllowedByPolicy(state, "llm", selection.mode)) return false;
  if (selection.mode === "providers") {
    return isProviderAllowedByPolicy(state, "llm", selection.provider);
  }
  if (selection.mode === "enterprise") {
    return isEnterpriseProviderAllowed(state, selection.provider);
  }
  return true;
}

export interface TranscriptionSelection {
  mode: InferenceMode;
  provider: string;
}

export function isTranscriptionSelectionAllowed(
  state: PolicyDecisionSnapshot,
  selection: TranscriptionSelection
): boolean {
  if (!isModeAllowedByPolicy(state, "transcription", selection.mode)) return false;
  if (selection.mode !== "providers") return true;
  return isProviderAllowedByPolicy(state, "transcription", selection.provider);
}

export type TranscriptionPolicyContext = "dictation" | "meeting" | "upload";

export function getTranscriptionSelection(
  settings: SettingsState,
  context: TranscriptionPolicyContext
): TranscriptionSelection {
  if (context === "meeting") {
    return {
      mode: settings.meetingTranscriptionMode,
      provider: settings.meetingCloudTranscriptionProvider || settings.cloudTranscriptionProvider,
    };
  }
  if (context === "upload") {
    return {
      mode: settings.uploadTranscriptionMode,
      provider: settings.uploadCloudTranscriptionProvider || settings.cloudTranscriptionProvider,
    };
  }
  return {
    mode: settings.transcriptionMode,
    provider: settings.cloudTranscriptionProvider,
  };
}

export function isTranscriptionContextAllowed(
  state: PolicyDecisionSnapshot,
  settings: SettingsState,
  context: TranscriptionPolicyContext
): boolean {
  return isTranscriptionSelectionAllowed(state, getTranscriptionSelection(settings, context));
}

/** Whether a note share visibility is allowed under the org's external-sharing mode. */
export function isShareVisibilityAllowed(
  state: PolicyDecisionSnapshot,
  visibility: ShareVisibility
): boolean {
  return managedPolicyDecision(state, (policy) => {
    const mode = policy.sharing.externalLinkSharing;
    if (mode === "allowed") return true;
    if (mode === "domain_only") return visibility === "private" || visibility === "domain";
    return visibility === "private";
  });
}

/** Hide policy-denied sharing choices while always retaining private recovery. */
export function filterShareVisibilityOptions<T extends { id: ShareVisibility }>(
  options: T[],
  state: PolicyDecisionSnapshot
): T[] {
  return options.filter((option) => isShareVisibilityAllowed(state, option.id));
}

/** Whether this surface can offer at least one exposure-increasing share mode. */
export function hasUsableExternalShareVisibility(
  state: PolicyDecisionSnapshot,
  canOfferDomainVisibility: boolean
): boolean {
  return (
    isShareVisibilityAllowed(state, "link") ||
    isShareVisibilityAllowed(state, "invited") ||
    (canOfferDomainVisibility && isShareVisibilityAllowed(state, "domain"))
  );
}

export type SharePolicyAction =
  | "create-link"
  | "copy-link"
  | "rotate-link"
  | "invite"
  | "resend-invitation"
  | "create-grant"
  | "change-grant"
  | "set-domain"
  | "make-private"
  | "revoke-invitation"
  | "remove-grant";

export function isShareActionAllowed(
  state: PolicyDecisionSnapshot,
  action: SharePolicyAction,
  currentVisibility: ShareVisibility
): boolean {
  if (action === "make-private" || action === "revoke-invitation" || action === "remove-grant") {
    return true;
  }
  if (action === "copy-link" || action === "rotate-link") {
    // A domain or invited share has a link too, scoped by that visibility, so
    // the current visibility governs rather than open link sharing.
    return currentVisibility !== "private" && isShareVisibilityAllowed(state, currentVisibility);
  }
  if (action === "create-link") return isShareVisibilityAllowed(state, "link");
  if (action === "set-domain") return isShareVisibilityAllowed(state, "domain");
  return isShareVisibilityAllowed(state, "invited");
}

export function canChangeCloudBackupPreference(
  policyAllowsBackup: boolean,
  backupCurrentlyEnabled: boolean
): boolean {
  return policyAllowsBackup || backupCurrentlyEnabled;
}

export function isControlPanelViewAllowed(
  view: string,
  agentAllowed: boolean,
  policyActionsAllowed: boolean
): boolean {
  if (view === "chat") return agentAllowed;
  if (view === "upload") return policyActionsAllowed;
  return true;
}

function policyModeHasAvailableProvider(
  policy: OrgPolicy,
  scope: PolicyScope,
  mode: InferenceMode,
  providerCatalog?: Pick<PolicySelectionCatalog, "byokProviders" | "enterpriseProviders">
): boolean {
  if (mode === "providers") {
    return providerCatalog
      ? providerCatalog.byokProviders.some((provider) =>
          policy[scope].allowedByokProviders.includes(provider)
        )
      : policy[scope].allowedByokProviders.length > 0;
  }
  if (mode === "enterprise") {
    const selectableProviders = providerCatalog?.enterpriseProviders ?? ["bedrock"];
    return (
      scope === "llm" &&
      selectableProviders.some((provider) =>
        policy.llm.allowedEnterpriseProviders.includes(provider)
      )
    );
  }
  return true;
}

/** Hide policy-denied modes while preserving the complete unmanaged catalog. */
export function filterModeOptionsByPolicy<T extends { id: InferenceMode }>(
  options: T[],
  scope: PolicyScope,
  state: PolicyDecisionSnapshot,
  providerCatalog?: Pick<PolicySelectionCatalog, "byokProviders" | "enterpriseProviders">
): T[] {
  if (state.status === "idle" || state.status === "unmanaged") return options;
  if (state.status !== "managed" || !state.policy) return [];
  return options.filter(
    (option) =>
      isModeAllowedByPolicy(state, scope, option.id) &&
      policyModeHasAvailableProvider(state.policy, scope, option.id, providerCatalog)
  );
}

/** Return the first usable allowed mode only when a managed selection must change. */
export function reconcilePolicyModeSelection<T extends { id: InferenceMode; disabled?: boolean }>(
  options: T[],
  scope: PolicyScope,
  state: PolicyDecisionSnapshot,
  selectedMode: InferenceMode,
  providerCatalog?: Pick<PolicySelectionCatalog, "byokProviders" | "enterpriseProviders">
): InferenceMode | null {
  if (state.status !== "managed") return null;
  const allowedOptions = filterModeOptionsByPolicy(options, scope, state, providerCatalog);
  if (allowedOptions.some((option) => option.id === selectedMode && !option.disabled)) return null;
  return allowedOptions.find((option) => !option.disabled)?.id ?? null;
}

export function filterByokProviderOptionsByPolicy<T extends { id: string }>(
  options: T[],
  scope: PolicyScope,
  state: PolicyDecisionSnapshot
): T[] {
  if (state.status === "idle" || state.status === "unmanaged") return options;
  if (state.status !== "managed" || !state.policy) return [];
  return options.filter((option) => isProviderAllowedByPolicy(state, scope, option.id));
}

export function filterEnterpriseProviderOptionsByPolicy<T extends { id: string }>(
  options: T[],
  state: PolicyDecisionSnapshot
): T[] {
  if (state.status === "idle" || state.status === "unmanaged") return options;
  if (state.status !== "managed" || !state.policy) return [];
  return options.filter((option) => isEnterpriseProviderAllowed(state, option.id));
}

/** Preserve legacy fallback writes only when no managed policy can be overwritten. */
export function shouldPersistProviderFallback(
  state: PolicyDecisionSnapshot,
  isSignedIn: boolean
): boolean {
  return state.status === "unmanaged" || (state.status === "idle" && !isSignedIn);
}

export function reconcileProviderSelection<T extends { id: string; disabled?: boolean }>(
  selectedProvider: string,
  allowedProviders: readonly T[]
): string | null {
  if (allowedProviders.some((provider) => provider.id === selectedProvider && !provider.disabled)) {
    return null;
  }
  return allowedProviders.find((provider) => !provider.disabled)?.id ?? null;
}

interface CloudProviderOption {
  id: string;
  models?: ReadonlyArray<{ id: string }>;
}

export function reconcileCloudProviderSelection({
  selectedProvider,
  selectedModel,
  allowedProviders,
  customAllowed,
  hasCustomUrl,
}: {
  selectedProvider: string;
  selectedModel: string;
  allowedProviders: readonly CloudProviderOption[];
  customAllowed: boolean;
  hasCustomUrl: boolean;
}): { provider: string; model: string } | null {
  if (selectedProvider === "custom" && customAllowed) return null;
  const selected = allowedProviders.find((provider) => provider.id === selectedProvider);
  if (selected) {
    if (!selected.models?.length || selected.models.some((model) => model.id === selectedModel)) {
      return null;
    }
    return { provider: selected.id, model: selected.models[0].id };
  }
  if (hasCustomUrl && customAllowed) {
    return { provider: "custom", model: selectedModel || "whisper-1" };
  }
  const first = allowedProviders[0];
  if (!first) {
    return customAllowed ? { provider: "custom", model: selectedModel || "whisper-1" } : null;
  }
  return { provider: first.id, model: first.models?.[0]?.id ?? "" };
}
