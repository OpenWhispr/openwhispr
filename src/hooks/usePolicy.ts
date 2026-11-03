import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePolicyStore } from "../stores/policyStore";
import { useManagedScopeResolution } from "../stores/enterpriseIdentityStore";
import { selectPolicyEffectiveSettings, useSettingsStore } from "../stores/settingsStore";
import {
  filterModeOptionsByPolicy,
  getTranscriptionSelection,
  isModeAllowedByPolicy,
  isTranscriptionSelectionAllowed,
  isAudioFeatureAllowed,
  reconcilePolicyModeSelection,
  transcriptionChoiceRefusal,
  type LocalModelRefusal,
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
  const setupMode = useSettingsStore((settings) => settings.enterpriseTranscriptionSetupMode);
  const managed = useManagedScopeResolution(
    "transcription",
    setupMode,
    context === "meeting" ? "realtime" : "batch"
  );
  // Managed audio outranks the personal selection, which a restricted model list
  // may refuse. A meeting's setup error still reaches the start, which reports it.
  const usesManagedRoute =
    managed.kind === "managed" || (context === "meeting" && managed.kind === "error");
  return (
    isAudioFeatureAllowed(snapshot, context) &&
    (usesManagedRoute || isTranscriptionSelectionAllowed(snapshot, selection))
  );
}

/** Why the personal selection is refused, when choosing another local model would fix it. */
export function useTranscriptionChoiceRefusal(
  context: TranscriptionPolicyContext
): LocalModelRefusal | null {
  const snapshot = usePolicySnapshot();
  return useSettingsStore(
    useShallow((settings) =>
      transcriptionChoiceRefusal(
        snapshot,
        selectPolicyEffectiveSettings(settings, snapshot),
        context
      )
    )
  );
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
