import i18n from "../i18n";
import {
  isAgentAllowed,
  isLlmSelectionAllowed,
  isLocalChoiceRefusal,
  localModelRefusal,
} from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import type { InferenceMode } from "../types/electron";

export function assertReasoningAllowedByPolicy(
  provider: string,
  mode: InferenceMode,
  model?: string
): void {
  const state = usePolicyStore.getState();
  if (isLlmSelectionAllowed(state, { mode, provider, model })) return;
  if (mode === "local") {
    const { code, messageKey, settingsTarget } = localModelRefusal(state, "llm");
    throw Object.assign(new Error(i18n.t(messageKey)), {
      code,
      messageKey,
      ...(isLocalChoiceRefusal(code) ? { settingsTarget } : {}),
    });
  }
  throw Object.assign(new Error(i18n.t("common.policyAiProcessingRestricted")), {
    code: "POLICY_RESTRICTED",
  });
}

export function assertAgentAllowedByPolicy(): void {
  if (!isAgentAllowed(usePolicyStore.getState())) {
    throw new Error(i18n.t("common.policyAgentRestricted"));
  }
}
