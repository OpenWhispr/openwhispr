import type { InferenceMode, ShareVisibility } from "../types/electron";
import type { OrgPolicy, PolicyScope } from "../types/policy";
import type { SettingsState } from "./settingsStore";
import { compareAppVersions } from "../utils/version.ts";

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

/** Mark policy-disallowed mode options disabled with a "managed" badge. */
export function enforceModeOptions<
  T extends { id: InferenceMode; disabled?: boolean; badge?: string },
>(options: T[], scope: PolicyScope, state: PolicyDecisionSnapshot, managedBadge: string): T[] {
  if (state.status === "idle" || state.status === "unmanaged") return options;
  return options.map((option) =>
    isModeAllowedByPolicy(state, scope, option.id)
      ? option
      : { ...option, disabled: true, badge: managedBadge }
  );
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
    if (selectedModel || !selected.models?.length) return null;
    return { provider: selected.id, model: selected.models[0].id };
  }
  if (hasCustomUrl && customAllowed) {
    return { provider: "custom", model: selectedModel || "whisper-1" };
  }
  const first = allowedProviders[0];
  if (!first) return null;
  return { provider: first.id, model: first.models?.[0]?.id ?? "" };
}
