import i18n from "../i18n";
import { isAgentAllowed, isLlmSelectionAllowed } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import type { InferenceMode } from "../types/electron";

export function assertReasoningAllowedByPolicy(provider: string, mode: InferenceMode): void {
  if (!isLlmSelectionAllowed(usePolicyStore.getState(), { mode, provider })) {
    throw new Error(i18n.t("common.policyAiProcessingRestricted"));
  }
}

export function assertAgentAllowedByPolicy(): void {
  if (!isAgentAllowed(usePolicyStore.getState())) {
    throw new Error(i18n.t("common.policyAgentRestricted"));
  }
}
