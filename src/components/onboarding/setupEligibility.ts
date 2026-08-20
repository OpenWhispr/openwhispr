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
  transcriptionProviders,
  llmProviders,
}: {
  policy: PolicyDecisionSnapshot;
  transcriptionProviders: ProviderOption[];
  llmProviders: ProviderOption[];
}): OnboardingSetupAvailability {
  const cloud =
    isModeAllowedByPolicy(policy, "transcription", "openwhispr") &&
    isModeAllowedByPolicy(policy, "llm", "openwhispr");
  const local =
    isModeAllowedByPolicy(policy, "transcription", "local") &&
    isModeAllowedByPolicy(policy, "llm", "local");
  const byok =
    isModeAllowedByPolicy(policy, "transcription", "providers") &&
    isModeAllowedByPolicy(policy, "llm", "providers") &&
    filterByokProviderOptionsByPolicy(transcriptionProviders, "transcription", policy).length > 0 &&
    filterByokProviderOptionsByPolicy(llmProviders, "llm", policy).length > 0;
  const selfHosted =
    isModeAllowedByPolicy(policy, "transcription", "self-hosted") &&
    isModeAllowedByPolicy(policy, "llm", "self-hosted") &&
    isProviderAllowedByPolicy(policy, "transcription", "custom") &&
    isProviderAllowedByPolicy(policy, "llm", "custom");

  return { cloud, local, byok, selfHosted };
}

export function hasAvailableOnboardingSetup(availability: OnboardingSetupAvailability): boolean {
  return Object.values(availability).some(Boolean);
}
