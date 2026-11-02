import i18n from "../i18n";
import {
  isAgentAllowed,
  isLlmSelectionAllowed,
  isPolicyActionAllowed,
  isModeAllowedByPolicy,
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
    const [code, messageKey] =
      state.status === "loading" ||
      state.status === "error" ||
      (state.status === "managed" && !state.policy)
        ? ["POLICY_UNRESOLVABLE", "models.policy.unresolved"]
        : !isPolicyActionAllowed(state)
          ? ["POLICY_APP_VERSION_BLOCKED", "models.policy.versionBlocked"]
          : !isModeAllowedByPolicy(state, "llm", "local")
            ? ["POLICY_LOCAL_MODE_BLOCKED", "models.policy.modeBlocked"]
            : ["POLICY_MODEL_BLOCKED", "models.policy.modelBlocked"];
    throw Object.assign(new Error(i18n.t(messageKey)), { code });
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
