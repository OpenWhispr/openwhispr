import { resolveManagedLocalModelLockSnapshot } from "../components/onboarding/managedLocalModels";
import {
  selectEffectiveManagedLocalModels,
  useEnterpriseIdentityStore,
} from "../stores/enterpriseIdentityStore";
import {
  isModeAllowedByPolicy,
  isTranscriptionSelectionAllowed,
  type PolicyDecisionSnapshot,
} from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import i18n from "../i18n";

export interface ManagedLocalTranscriptionRuntimeSettings {
  transcriptionMode?: string;
  useLocalWhisper?: boolean;
  localTranscriptionProvider?: string;
  whisperModel?: string;
  parakeetModel?: string;
}

export type ManagedLocalTranscriptionRuntimeResolution<
  T extends ManagedLocalTranscriptionRuntimeSettings,
> =
  | { kind: "ready"; managed: boolean; settings: T }
  | { kind: "error"; code: "MANAGED_CONFIG_UNAVAILABLE" | "POLICY_RESTRICTED"; message: string };

export function resolveManagedLocalTranscriptionRuntime<
  T extends ManagedLocalTranscriptionRuntimeSettings,
>(settings: T): ManagedLocalTranscriptionRuntimeResolution<T> {
  const enterprise = useEnterpriseIdentityStore.getState();
  const lock = resolveManagedLocalModelLockSnapshot(
    {
      accountId: enterprise.accountId,
      workspaceId: enterprise.workspaceId,
      localModels: selectEffectiveManagedLocalModels(enterprise),
      localModelsKnown: enterprise.lastKnownLocalModelsKnown,
      failClosed: enterprise.failClosed,
    },
    "transcription"
  );
  if (!lock.managed) return { kind: "ready", managed: false, settings };
  if (!lock.selection) {
    return {
      kind: "error",
      code: "MANAGED_CONFIG_UNAVAILABLE",
      message: i18n.t("managedLocalModels.runtime.transcriptionUnavailable"),
    };
  }
  if (!isModeAllowedByPolicy(usePolicyStore.getState(), "transcription", "local")) {
    return {
      kind: "error",
      code: "POLICY_RESTRICTED",
      message: i18n.t("common.policyTranscriptionRestricted"),
    };
  }
  const provider = lock.selection.provider === "nvidia" ? "nvidia" : "whisper";
  return {
    kind: "ready",
    managed: true,
    settings: {
      ...settings,
      transcriptionMode: "local",
      useLocalWhisper: true,
      localTranscriptionProvider: provider,
      ...(provider === "nvidia"
        ? { parakeetModel: lock.selection.modelId }
        : { whisperModel: lock.selection.modelId }),
    },
  };
}

export function isManagedLocalTranscriptionRuntimeAllowed<
  T extends ManagedLocalTranscriptionRuntimeSettings & { cloudTranscriptionProvider?: string },
>(
  resolution: ManagedLocalTranscriptionRuntimeResolution<T>,
  policy: PolicyDecisionSnapshot
): boolean {
  if (resolution.kind === "error") return false;
  const settings = resolution.settings;
  return isTranscriptionSelectionAllowed(policy, {
    mode: (settings.transcriptionMode ||
      (settings.useLocalWhisper ? "local" : "providers")) as never,
    provider: settings.cloudTranscriptionProvider || "",
  });
}
