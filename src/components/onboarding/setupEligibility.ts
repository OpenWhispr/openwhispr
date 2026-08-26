import {
  filterByokProviderOptionsByPolicy,
  isModeAllowedByPolicy,
  isProviderAllowedByPolicy,
  type PolicyDecisionSnapshot,
} from "../../stores/policyRules.ts";

interface ProviderOption {
  id: string;
}

export interface OnboardingSetupAvailability {
  cloud: boolean;
  local: boolean;
  byok: boolean;
  selfHosted: boolean;
}

/**
 * A setup card is available only when every stage behind it has at least one
 * usable option. Checking modes alone can expose a route whose provider list is
 * empty after workspace-policy filtering.
 */
export function getOnboardingSetupAvailability({
  policy,
  agentAllowed,
  transcriptionProviders,
  llmProviders,
}: {
  policy: PolicyDecisionSnapshot;
  agentAllowed: boolean;
  transcriptionProviders: ProviderOption[];
  llmProviders: ProviderOption[];
}): OnboardingSetupAvailability {
  const transcriptionByokAvailable =
    isModeAllowedByPolicy(policy, "transcription", "providers") &&
    filterByokProviderOptionsByPolicy(transcriptionProviders, "transcription", policy).length > 0;
  const llmByokAvailable =
    isModeAllowedByPolicy(policy, "llm", "providers") &&
    filterByokProviderOptionsByPolicy(llmProviders, "llm", policy).length > 0;

  const cloud =
    isModeAllowedByPolicy(policy, "transcription", "openwhispr") &&
    (!agentAllowed || isModeAllowedByPolicy(policy, "llm", "openwhispr"));
  const local =
    isModeAllowedByPolicy(policy, "transcription", "local") &&
    (!agentAllowed || isModeAllowedByPolicy(policy, "llm", "local"));
  const byok = transcriptionByokAvailable && (!agentAllowed || llmByokAvailable);
  const selfHosted =
    isModeAllowedByPolicy(policy, "transcription", "self-hosted") &&
    isProviderAllowedByPolicy(policy, "transcription", "custom") &&
    (!agentAllowed ||
      (isModeAllowedByPolicy(policy, "llm", "self-hosted") &&
        isProviderAllowedByPolicy(policy, "llm", "custom")));

  return { cloud, local, byok, selfHosted };
}

export function hasAvailableOnboardingSetup(availability: OnboardingSetupAvailability): boolean {
  return Object.values(availability).some(Boolean);
}
