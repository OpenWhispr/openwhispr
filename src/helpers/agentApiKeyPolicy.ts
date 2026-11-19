import { usePolicyStore } from "../stores/policyStore";
import { isAgentAllowed, isLlmSelectionAllowed } from "../stores/policyRules";
import { getManagedScopeResolution } from "../stores/enterpriseIdentityStore";
import type { ChatInferenceScope } from "../types/agentInteractions";

export function isApiKeySetupAllowed(provider: string, scope: ChatInferenceScope): boolean {
  const policy = usePolicyStore.getState();
  if (!isAgentAllowed(policy) || !isLlmSelectionAllowed(policy, { mode: "providers", provider })) {
    return false;
  }
  return getManagedScopeResolution(scope, "manual").kind === "manual";
}
