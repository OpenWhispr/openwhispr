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

/**
 * The check for work already running, which ends only on a settled denial: an
 * unresolved verdict says nothing new about it. A device policy that can't be
 * read is a denial.
 */
export function runningPolicyCheck(assertAllowed: () => void): () => void {
  return () => {
    const { status, code } = usePolicyStore.getState();
    const unresolved =
      (status === "loading" || status === "error") && code !== "DEVICE_POLICY_INVALID";
    if (!unresolved) assertAllowed();
  };
}

export function onPolicyRestriction(assertAllowed: () => void, stop: (error: unknown) => void) {
  return usePolicyStore.subscribe(() => {
    try {
      assertAllowed();
    } catch (error) {
      stop(error);
    }
  });
}
