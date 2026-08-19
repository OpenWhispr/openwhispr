import {
  filterByokProviderOptionsByPolicy,
  isModeAllowedByPolicy,
  isProviderAllowedByPolicy,
  type PolicyDecisionSnapshot,
} from "../../stores/policyRules.ts";

/**
 * Which transcription step (if any) the enterprise onboarding route must
 * include. "enterprise" is an LLM-only mode — TRANSCRIPTION_POLICY_CATALOG has
 * no such entry — so speech-to-text still has to be provisioned from the
 * ordinary transcription modes. Without this, a policy that disallows the
 * OpenWhispr cloud gets clamped at request time (selectPolicyEffectiveSettings)
 * to a mode onboarding never set up: local with no model downloaded, or BYOK
 * providers with no key.
 */
export type EnterpriseTranscriptionNeed = "none" | "byok" | "local" | "self-hosted" | "unavailable";

export function getEnterpriseTranscriptionNeed(
  policy: PolicyDecisionSnapshot,
  transcriptionProviders: Array<{ id: string }>
): EnterpriseTranscriptionNeed {
  if (isModeAllowedByPolicy(policy, "transcription", "openwhispr")) return "none";
  if (
    isModeAllowedByPolicy(policy, "transcription", "providers") &&
    filterByokProviderOptionsByPolicy(transcriptionProviders, "transcription", policy).length > 0
  ) {
    return "byok";
  }
  if (isModeAllowedByPolicy(policy, "transcription", "local")) return "local";
  // The self-hosted form is the BYOK step's "custom" provider variant, so it is
  // only usable when that provider id survives the policy filter.
  if (
    isModeAllowedByPolicy(policy, "transcription", "self-hosted") &&
    isProviderAllowedByPolicy(policy, "transcription", "custom")
  ) {
    return "self-hosted";
  }
  // Keep this distinct from "none", which means OpenWhispr cloud is allowed.
  // Otherwise onboarding would provision a policy-forbidden cloud provider.
  return "unavailable";
}
