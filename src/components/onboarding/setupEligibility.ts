import {
  filterByokProviderOptionsByPolicy,
  isEnterpriseProviderAllowed,
  isModeAllowedByPolicy,
  isProviderAllowedByPolicy,
  type PolicyDecisionSnapshot,
} from "../../stores/policyRules.ts";
import type { EnterpriseTranscriptionNeed } from "./enterpriseTranscription.ts";

interface ProviderOption {
  id: string;
}

export interface OnboardingSetupAvailability {
  cloud: boolean;
  local: boolean;
  byok: boolean;
  selfHosted: boolean;
  enterprise: boolean;
}

/**
 * A setup card is available only when every stage behind it has at least one
 * usable option. Checking modes alone can expose a route whose provider list is
 * empty after workspace-policy filtering.
 */
export function getOnboardingSetupAvailability({
  policy,
  enterpriseTranscription,
  transcriptionProviders,
  llmProviders,
  managedEnterpriseAvailable,
}: {
  policy: PolicyDecisionSnapshot;
  enterpriseTranscription: EnterpriseTranscriptionNeed;
  transcriptionProviders: ProviderOption[];
  llmProviders: ProviderOption[];
  managedEnterpriseAvailable: boolean;
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
  const manualEnterpriseAvailable = ["bedrock", "azure"].some((provider) =>
    isEnterpriseProviderAllowed(policy, provider)
  );
  const enterprise =
    enterpriseTranscription !== "unavailable" &&
    isModeAllowedByPolicy(policy, "llm", "enterprise") &&
    (managedEnterpriseAvailable || manualEnterpriseAvailable);

  return { cloud, local, byok, selfHosted, enterprise };
}

export function hasAvailableOnboardingSetup(availability: OnboardingSetupAvailability): boolean {
  return Object.values(availability).some(Boolean);
}
