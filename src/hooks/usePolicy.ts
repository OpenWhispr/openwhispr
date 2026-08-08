import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { usePolicyStore } from "../stores/policyStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  enforceModeOptions,
  getTranscriptionSelection,
  isModeAllowedByPolicy,
  isTranscriptionSelectionAllowed,
  type PolicyDecisionSnapshot,
  type TranscriptionPolicyContext,
} from "../stores/policyRules";
import type { InferenceMode } from "../types/electron";
import type { PolicyScope } from "../types/policy";

/** The minimal reactive snapshot consumed by the pure policy rules. */
export function usePolicySnapshot(): PolicyDecisionSnapshot {
  const status = usePolicyStore((state) => state.status);
  const policy = usePolicyStore((state) => state.policy);
  const appVersion = usePolicyStore((state) => state.appVersion);
  return useMemo(() => ({ status, policy, appVersion }), [status, policy, appVersion]);
}

/** Reactive to both stores — updates when the policy or the relevant settings change. */
export function useTranscriptionContextAllowed(context: TranscriptionPolicyContext): boolean {
  const snapshot = usePolicySnapshot();
  const selection = useSettingsStore(useShallow((s) => getTranscriptionSelection(s, context)));
  return isTranscriptionSelectionAllowed(snapshot, selection);
}

interface PolicyModeOptions<T> {
  modes: T[];
  /**
   * "Disabled" mode options still fire onSelect (the sign-in gate relies on
   * that to start onboarding), so call this at the top of the select handler —
   * policy must be enforced there, not in the UI.
   */
  isModeAllowed: (mode: InferenceMode) => boolean;
}

/** Mode options with policy-disallowed entries disabled and badged. */
export function usePolicyModeOptions<
  T extends { id: InferenceMode; disabled?: boolean; badge?: string },
>(options: T[], scope: PolicyScope): PolicyModeOptions<T> {
  const { t } = useTranslation();
  const snapshot = usePolicySnapshot();
  return {
    modes: enforceModeOptions(options, scope, snapshot, t("common.managedByOrg")),
    isModeAllowed: (mode: InferenceMode) => isModeAllowedByPolicy(snapshot, scope, mode),
  };
}
