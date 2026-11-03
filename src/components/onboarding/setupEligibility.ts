import {
  filterByokProviderOptionsByPolicy,
  filterLocalModelOptionsByPolicy,
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
  supportedLocalTranscriptionModels,
}: {
  policy: PolicyDecisionSnapshot;
  agentAllowed: boolean;
  transcriptionProviders: ProviderOption[];
  llmProviders: ProviderOption[];
  supportedLocalTranscriptionModels: ProviderOption[];
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
  // Only speech decides: the local assistant step is optional, and when AI text
  // is blocked it says so and offers Skip.
  const local =
    filterLocalModelOptionsByPolicy(supportedLocalTranscriptionModels, "transcription", policy)
      .length > 0;
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
