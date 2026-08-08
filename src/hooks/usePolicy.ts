import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePolicyStore } from "../stores/policyStore";
import { selectPolicyEffectiveSettings, useSettingsStore } from "../stores/settingsStore";
import {
  filterModeOptionsByPolicy,
  getTranscriptionSelection,
  isModeAllowedByPolicy,
  isTranscriptionSelectionAllowed,
  reconcilePolicyModeSelection,
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
  const selection = useSettingsStore(
    useShallow((settings) =>
      getTranscriptionSelection(selectPolicyEffectiveSettings(settings, snapshot), context)
    )
  );
  return isTranscriptionSelectionAllowed(snapshot, selection);
}

interface PolicyModeOptions<T> {
  modes: T[];
  effectiveMode: InferenceMode | null;
  /**
   * Selection handlers still enforce policy in case a stale renderer event
   * arrives after an option disappears.
   */
  isModeAllowed: (mode: InferenceMode) => boolean;
}

/** Visible mode options and a deterministic replacement for a denied managed selection. */
export function usePolicyModeOptions<T extends { id: InferenceMode; disabled?: boolean }>(
  options: T[],
  scope: PolicyScope,
  selectedMode: InferenceMode,
  providerCatalog?: {
    byokProviders: readonly string[];
    enterpriseProviders?: readonly string[];
  }
): PolicyModeOptions<T> {
  const snapshot = usePolicySnapshot();
  const modes = filterModeOptionsByPolicy(options, scope, snapshot, providerCatalog);
  const selectionIsVisible = modes.some((option) => option.id === selectedMode && !option.disabled);
  const preservesRawSelection = snapshot.status === "idle" || snapshot.status === "unmanaged";
  return {
    modes,
    effectiveMode:
      preservesRawSelection || selectionIsVisible
        ? selectedMode
        : reconcilePolicyModeSelection(options, scope, snapshot, selectedMode, providerCatalog),
    isModeAllowed: (mode: InferenceMode) => isModeAllowedByPolicy(snapshot, scope, mode),
  };
}
