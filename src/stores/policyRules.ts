import { pickDefaultModelId } from "../models/providerDefaultModel.ts";
import type { InferenceMode, ShareVisibility } from "../types/electron";
import type { OrgPolicy, PolicyScope } from "../types/policy";
import type { SettingsState } from "./settingsStore";
import { compareAppVersions } from "../utils/version.ts";
// The pure registry store keeps this policy module usable without browser globals.
// Provider membership is code-pinned by catalog compatibility validation.
import {
  listRunnableLocalModels,
  registryData as modelRegistryData,
} from "../models/registryData.js";
import { isUploadOnlyTranscriptionModel } from "../models/appTranscriptionProviders.js";

export type PolicyStatus = "idle" | "loading" | "managed" | "unmanaged" | "error";

export interface PolicyDecisionSnapshot {
  status: PolicyStatus;
  policy: OrgPolicy | null;
  appVersion: string | null;
}

function managedPolicy(state: PolicyDecisionSnapshot): OrgPolicy | null {
  return state.status === "managed" && state.policy ? state.policy : null;
}

const KNOWN_BYOK_PROVIDER_IDS: Record<PolicyScope, ReadonlySet<string>> = {
  transcription: new Set([
    ...modelRegistryData.transcriptionProviders.map((provider) => provider.id),
    "custom",
  ]),
  llm: new Set([
    ...modelRegistryData.cloudProviders.map((provider) => provider.id),
    "custom",
    "openrouter",
  ]),
};

const warnedUnknownByokProviderIds = new Set<string>();

/**
 * The scope's BYOK allowlist, filtered to provider ids this build knows. The
 * field is validated shape-only, so an id from a newer server reaches here and
 * is dropped with a warning instead of invalidating the whole policy — it can
 * grant nothing an older app could act on. Mirrors requiredLocalModelIds.
 */
function allowedByokProviderIds(policy: OrgPolicy, scope: PolicyScope): string[] {
  const known = KNOWN_BYOK_PROVIDER_IDS[scope];
  return policy[scope].allowedByokProviders.filter((id) => {
    if (known.has(id)) return true;
    const key = `${scope}:${id}`;
    if (!warnedUnknownByokProviderIds.has(key)) {
      warnedUnknownByokProviderIds.add(key);
      console.warn(`[policy] Ignoring unknown ${scope} BYOK provider id: ${id}`);
    }
    return false;
  });
}

export function isPolicyActionAllowed(state: PolicyDecisionSnapshot): boolean {
  if (state.status === "idle" || state.status === "unmanaged") return true;
  if (state.status !== "managed" || !state.policy) return false;
  if (!state.policy.minAppVersion) return true;
  if (!state.appVersion) return false;
  return compareAppVersions(state.appVersion, state.policy.minAppVersion) >= 0;
}

/** A start mode this build doesn't know counts as manual. */
export function isMeetingTranscriptionStartManual(state: PolicyDecisionSnapshot): boolean {
  const policy = managedPolicy(state);
  return policy !== null && (policy.meetings?.transcriptionStart ?? "automatic") !== "automatic";
}

/** A signed-in window must resolve policy before treating note navigation as consent. */
export function isMeetingAutoTranscriptionAllowed(
  state: PolicyDecisionSnapshot,
  isSignedIn: boolean
): boolean {
  if (state.status === "unmanaged") return true;
  if (state.status === "idle") return !isSignedIn;
  if (!isPolicyActionAllowed(state)) return false;
  return managedPolicy(state) !== null && !isMeetingTranscriptionStartManual(state);
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

/**
 * Whether the managed policy that can force local history off has settled.
 *
 * `effectiveLocalHistoryEnabled` resolves an unsettled policy to the user's own
 * preference, which is the right value to show and to sweep retention with --
 * but it is a default, not an answer, and one consumer reads that switch as
 * consent: the main process reconstructs Insights history from stored
 * transcripts the first time the renderer reports it. A scan finishes in
 * milliseconds while the policy is a network round trip, so a workspace with
 * `localHistoryMode: "always_off"` would have its members' existing transcripts
 * mined before the policy forbidding it ever arrived.
 *
 * `idle` is unsettled here even though `isPolicyActionAllowed` treats it as
 * permissive, because it covers both "no account" and "signed in, fetch not
 * started". Only the main process can tell those apart, from the account scope
 * it persists, so it makes that call.
 */
export function isLocalHistoryPolicyResolved(state: PolicyDecisionSnapshot): boolean {
  return state.status === "managed" || state.status === "unmanaged";
}

/**
 * Whether this window has applied whatever policy it will get. `idle` and
 * `loading` may still be a signed-in window before its fetch lands, while
 * `error` applies no policy and is as final as `managed` or `unmanaged`.
 */
export function isPolicySettled(state: PolicyDecisionSnapshot): boolean {
  return state.status !== "idle" && state.status !== "loading";
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
    allowedByokProviderIds(policy, scope).includes(providerId)
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

/**
 * Whether an enterprise cloud may run managed transcription. The field is
 * absent on servers that predate it; absent means none.
 */
export function isTranscriptionEnterpriseProviderAllowed(
  state: PolicyDecisionSnapshot,
  providerId: string
): boolean {
  return managedPolicyDecision(state, (policy) =>
    (policy.transcription.allowedEnterpriseProviders ?? []).includes(providerId)
  );
}

/**
 * Whether the "Enterprise cloud" transcription tile should ever be shown as
 * a selectable option. Unlike every other mode, "enterprise" can only ever
 * resolve for a managed org — resolveEffectivePolicySelection requires a
 * managed policy with a matching allowedEnterpriseProviders entry. Offering
 * the tile to an unmanaged/idle user would let them pick a mode with no
 * personal configuration surface and no managed resolution, which then
 * fails every dictation and upload closed via the transcription route's
 * fail-closed guard.
 */
export function isEnterpriseTranscriptionOfferable(state: PolicyDecisionSnapshot): boolean {
  return state.status === "managed";
}

/** Whether the AI agent (dictation, voice, and chat) is allowed. */
export function isAgentAllowed(state: PolicyDecisionSnapshot): boolean {
  return managedPolicyDecision(state, (policy) => policy.features.agentEnabled);
}

/** Whether the agent's web_search tool is allowed. */
export function isWebSearchAllowed(state: PolicyDecisionSnapshot): boolean {
  return managedPolicyDecision(state, (policy) => policy.features.webSearchEnabled);
}

/** Whether a resolved org policy turned web search off (not one still loading). */
export function isWebSearchBlockedByOrg(state: PolicyDecisionSnapshot): boolean {
  return state.status === "managed" && isPolicyActionAllowed(state) && !isWebSearchAllowed(state);
}

/**
 * Whether the voice agent may attach screen context. Servers that predate the
 * field send none; absent means allowed.
 */
export function isScreenContextAllowed(state: PolicyDecisionSnapshot): boolean {
  return managedPolicyDecision(state, (policy) => policy.features.screenContextEnabled !== false);
}

/**
 * Whether agent connectors may run. They are agent tools, so turning the
 * agent off turns them off too. Servers that predate the field send none;
 * absent means allowed.
 */
export function isConnectorsAllowed(state: PolicyDecisionSnapshot): boolean {
  return managedPolicyDecision(
    state,
    (policy) => policy.features.agentEnabled && policy.features.connectorsEnabled !== false
  );
}

/**
 * Whether a resolved org policy turned connectors off. Unlike
 * isConnectorsAllowed, a policy that is still loading or failed to load is not
 * reported as an org decision, and neither is one that only requires a newer
 * app version (the update banner says that).
 */
export function isConnectorsBlockedByOrg(state: PolicyDecisionSnapshot): boolean {
  return state.status === "managed" && isPolicyActionAllowed(state) && !isConnectorsAllowed(state);
}

const warnedUnknownRequiredModelIds = new Set<string>();
const warnedUnknownLocalModelIds = new Set<string>();

// Read live: a catalog update can add a local model during a session. A retired one stays
// known, since a file on disk and the work already running on it keep going
// (getRunnableSpeechModel).
export function isKnownLocalModelId(scope: PolicyScope, modelId: string): boolean {
  const sections =
    scope === "transcription"
      ? (["whisperModels", "parakeetModels"] as const)
      : (["localProviders"] as const);
  return sections.some((section) =>
    listRunnableLocalModels(section).some(([id]) => id === modelId)
  );
}

export function allowedLocalModelIds(
  state: PolicyDecisionSnapshot,
  scope: PolicyScope
): string[] | null {
  const ids = managedPolicy(state)?.[scope].allowedLocalModels;
  if (ids == null) return null;
  return ids.filter((id) => {
    if (isKnownLocalModelId(scope, id)) return true;
    const key = `${scope}:${id}`;
    if (!warnedUnknownLocalModelIds.has(key)) {
      warnedUnknownLocalModelIds.add(key);
      console.warn(`[policy] Ignoring unknown ${scope} local model id: ${id}`);
    }
    return false;
  });
}

/**
 * Only a managed policy judges the id: a guest's or unmanaged user's blank model
 * takes the engine's default, and an unknown one fails as any bad id does, so
 * neither is an organization's refusal.
 */
export function isLocalModelAllowedByPolicy(
  state: PolicyDecisionSnapshot,
  scope: PolicyScope,
  modelId: string
): boolean {
  return managedPolicyDecision(state, (policy) => {
    if (!isKnownLocalModelId(scope, modelId)) return false;
    if (!policy[scope].allowedModes.includes("local")) return false;
    const ids = allowedLocalModelIds(state, scope);
    return ids === null || ids.includes(modelId);
  });
}

export interface LocalModelRefusal {
  code:
    | "POLICY_UNRESOLVABLE"
    | "POLICY_APP_VERSION_BLOCKED"
    | "POLICY_LOCAL_MODE_BLOCKED"
    | "POLICY_MODEL_BLOCKED";
  messageKey: string;
  settingsTarget: "speechToText" | "llms";
}

/** Why the policy refuses a local selection in this scope. Call once it has refused. */
export function localModelRefusal(
  state: PolicyDecisionSnapshot,
  scope: PolicyScope
): LocalModelRefusal {
  const settingsTarget = scope === "llm" ? "llms" : "speechToText";
  if (
    state.status === "loading" ||
    state.status === "error" ||
    (state.status === "managed" && !state.policy)
  ) {
    return { code: "POLICY_UNRESOLVABLE", messageKey: "models.policy.unresolved", settingsTarget };
  }
  if (!isPolicyActionAllowed(state)) {
    return {
      code: "POLICY_APP_VERSION_BLOCKED",
      messageKey: "models.policy.versionBlocked",
      settingsTarget,
    };
  }
  if (!isModeAllowedByPolicy(state, scope, "local")) {
    return {
      code: "POLICY_LOCAL_MODE_BLOCKED",
      messageKey: "models.policy.modeBlocked",
      settingsTarget,
    };
  }
  return {
    code: "POLICY_MODEL_BLOCKED",
    messageKey:
      managedPolicy(state)?.[scope].allowedLocalModels?.length === 0
        ? "models.policy.emptyIntersection"
        : allowedLocalModelIds(state, scope)?.length === 0
          ? "models.policy.noneSupported"
          : "models.policy.modelBlocked",
    settingsTarget,
  };
}

/** What a refused model's row says: only a refusal the organization made names it. */
export function localModelRowRefusal(
  state: PolicyDecisionSnapshot,
  scope: PolicyScope
): { labelKey: string; hintKey: string } {
  const { code, messageKey } = localModelRefusal(state, scope);
  return {
    labelKey: isLocalChoiceRefusal(code)
      ? "models.policy.notApproved"
      : code === "POLICY_APP_VERSION_BLOCKED"
        ? "models.policy.updateRequired"
        : "models.policy.unavailable",
    hintKey: messageKey,
  };
}

/** The message for a local-model refusal that arrives as a code alone, as main sends it. */
export const LOCAL_MODEL_REFUSAL_MESSAGE_KEYS: Record<LocalModelRefusal["code"], string> = {
  POLICY_MODEL_BLOCKED: "models.policy.modelBlocked",
  POLICY_LOCAL_MODE_BLOCKED: "models.policy.modeBlocked",
  POLICY_UNRESOLVABLE: "models.policy.unresolved",
  POLICY_APP_VERSION_BLOCKED: "models.policy.versionBlocked",
};

export function isLocalChoiceRefusal(code: unknown): boolean {
  return code === "POLICY_MODEL_BLOCKED" || code === "POLICY_LOCAL_MODE_BLOCKED";
}

/** A refusal the member can fix by choosing again in Settings; null for any other. */
export function localChoiceRefusal(
  state: PolicyDecisionSnapshot,
  scope: PolicyScope
): LocalModelRefusal | null {
  const refusal = localModelRefusal(state, scope);
  return isLocalChoiceRefusal(refusal.code) ? refusal : null;
}

export function filterLocalModelOptionsByPolicy<T extends { id: string }>(
  options: T[],
  scope: PolicyScope,
  state: PolicyDecisionSnapshot
): T[] {
  return options.filter((option) => isLocalModelAllowedByPolicy(state, scope, option.id));
}

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
      if (!usable.includes(id) && isLocalModelAllowedByPolicy(state, "transcription", id))
        usable.push(id);
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
  model?: string;
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

  const policyByokProviders = allowedByokProviderIds(policy, scope);
  const allowedByokProviders = catalog.byokProviders.filter((provider) =>
    policyByokProviders.includes(provider)
  );
  const allowedEnterpriseProviders = (catalog.enterpriseProviders ?? []).filter((provider) =>
    (policy[scope].allowedEnterpriseProviders ?? []).includes(provider)
  );
  const modeIsUsable = (mode: InferenceMode): boolean => {
    if (!catalog.modes.includes(mode)) return false;
    if (!policy[scope].allowedModes.includes(mode)) return false;
    if (mode === "providers") return allowedByokProviders.length > 0;
    if (mode === "enterprise") return allowedEnterpriseProviders.length > 0;
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
  if (selection.mode === "local")
    return isLocalModelAllowedByPolicy(state, "llm", selection.model ?? "");
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
  model?: string;
}

export function isTranscriptionSelectionAllowed(
  state: PolicyDecisionSnapshot,
  selection: TranscriptionSelection
): boolean {
  if (selection.mode === "local")
    return isLocalModelAllowedByPolicy(state, "transcription", selection.model ?? "");
  if (!isModeAllowedByPolicy(state, "transcription", selection.mode)) return false;
  if (selection.mode === "providers") {
    return isProviderAllowedByPolicy(state, "transcription", selection.provider);
  }
  if (selection.mode === "enterprise") {
    return isTranscriptionEnterpriseProviderAllowed(state, selection.provider);
  }
  return true;
}

export type TranscriptionPolicyContext = "dictation" | "meeting" | "upload";

export function getTranscriptionSelection(
  settings: SettingsState,
  context: TranscriptionPolicyContext
): TranscriptionSelection {
  const prefix = context === "dictation" ? "" : context;
  const read = (
    key: "localTranscriptionProvider" | "whisperModel" | "parakeetModel" | "cohereModel"
  ): string => {
    const contextKey = prefix ? `${prefix}${key[0].toUpperCase()}${key.slice(1)}` : key;
    return (settings[contextKey as keyof SettingsState] as string) || settings[key];
  };
  const provider = read("localTranscriptionProvider");
  const model = settings.policyBlockedLocalScopes?.includes(context)
    ? ""
    : read(
        provider === "whisper"
          ? "whisperModel"
          : provider === "cohere"
            ? "cohereModel"
            : "parakeetModel"
      );
  if (context === "meeting") {
    return {
      model,
      mode: settings.meetingTranscriptionMode,
      provider: settings.meetingCloudTranscriptionProvider || settings.cloudTranscriptionProvider,
    };
  }
  if (context === "upload") {
    return {
      model,
      mode: settings.uploadTranscriptionMode,
      provider: settings.uploadCloudTranscriptionProvider || settings.cloudTranscriptionProvider,
    };
  }
  return {
    model,
    mode: settings.transcriptionMode,
    provider: settings.cloudTranscriptionProvider,
  };
}

export function isTranscriptionContextAllowed(
  state: PolicyDecisionSnapshot,
  settings: SettingsState,
  context: TranscriptionPolicyContext
): boolean {
  return (
    isAudioFeatureAllowed(state, context) &&
    isTranscriptionSelectionAllowed(state, getTranscriptionSelection(settings, context))
  );
}

/** Why a transcription context is refused, when choosing another local model would fix it. */
export function transcriptionChoiceRefusal(
  state: PolicyDecisionSnapshot,
  settings: SettingsState,
  context: TranscriptionPolicyContext
): LocalModelRefusal | null {
  if (!isAudioFeatureAllowed(state, context)) return null;
  const selection = getTranscriptionSelection(settings, context);
  if (selection.mode !== "local" || isTranscriptionSelectionAllowed(state, selection)) return null;
  return localChoiceRefusal(state, "transcription");
}

/**
 * Whether a settled verdict refuses this feature, which is what stops work
 * already running. New work also waits on an unresolved verdict
 * (isAudioFeatureAllowed), but one says nothing new about what's running.
 */
export function isAudioFeatureDenied(
  state: PolicyDecisionSnapshot,
  context: TranscriptionPolicyContext
): boolean {
  return state.status === "managed" && !!state.policy && !isAudioFeatureAllowed(state, context);
}

export function isAudioFeatureAllowed(
  state: PolicyDecisionSnapshot,
  context: TranscriptionPolicyContext
): boolean {
  return managedPolicyDecision(state, (policy) =>
    context === "meeting"
      ? policy.features.meetingRecordingEnabled !== false
      : context === "upload"
        ? policy.features.audioUploadEnabled !== false
        : true
  );
}

export type MeetingRecordingRefusal = "unresolved" | "disabled" | "restricted";

/**
 * Why policy refuses a meeting recording: no policy resolved yet, the org's
 * meeting recording switch, or another restriction (e.g. a minimum app version).
 */
export function meetingRecordingRefusal(state: PolicyDecisionSnapshot): MeetingRecordingRefusal {
  const policy = managedPolicy(state);
  if (!policy) return "unresolved";
  return policy.features.meetingRecordingEnabled === false ? "disabled" : "restricted";
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
  // A private note suspends its invitations and has no link for the email to carry.
  if (action === "resend-invitation" && currentVisibility === "private") return false;
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
    const allowed = allowedByokProviderIds(policy, scope);
    return providerCatalog
      ? providerCatalog.byokProviders.some((provider) => allowed.includes(provider))
      : allowed.length > 0;
  }
  if (mode === "enterprise") {
    const allowed = policy[scope].allowedEnterpriseProviders ?? [];
    const selectable =
      providerCatalog?.enterpriseProviders ?? (scope === "llm" ? ["bedrock"] : ["azure"]);
    return selectable.some((provider) => allowed.includes(provider));
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
  defaultModel?: string;
  models?: ReadonlyArray<{ id: string }>;
}

// OpenRouter's speech-to-text catalog moves faster than the shortlist we ship,
// so a vendor-prefixed id is a real selection even when the registry does not
// list it; a bare id is another provider's leftover. Shared by the picker, the
// settings store and the request resolver so none of them resets what another
// keeps.
export function acceptsUnlistedTranscriptionModel(providerId: string, modelId: string): boolean {
  return providerId === "openrouter" && modelId.includes("/");
}

// An upload-only model is listed, so the unlisted pass-through above must not
// keep it on a screen that leaves it out.
export { isUploadOnlyTranscriptionModel };

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
    if (
      !selected.models?.length ||
      selected.models.some((model) => model.id === selectedModel) ||
      (acceptsUnlistedTranscriptionModel(selected.id, selectedModel) &&
        !isUploadOnlyTranscriptionModel(selected.id, selectedModel))
    ) {
      return null;
    }
    return { provider: selected.id, model: pickDefaultModelId(selected) };
  }
  if (hasCustomUrl && customAllowed) {
    return { provider: "custom", model: selectedModel || "whisper-1" };
  }
  const first = allowedProviders[0];
  if (!first) {
    return customAllowed ? { provider: "custom", model: selectedModel || "whisper-1" } : null;
  }
  return { provider: first.id, model: pickDefaultModelId(first) };
}
