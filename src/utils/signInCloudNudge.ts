import { isModeAllowedByPolicy, type PolicyDecisionSnapshot } from "../stores/policyRules";
import type { InferenceMode } from "../types/electron";

/** How long after opening the sign-in prompt a finished sign-in still earns the nudge. */
export const SIGN_IN_CLOUD_NUDGE_WINDOW_MS = 15 * 60 * 1000;

export type SignInCloudNudgeDecision = "wait" | "nudge" | "skip";

export interface SignInCloudNudgeInputs {
  /** When the prompt was opened (epoch ms). */
  promptedAt: number;
  now: number;
  isSignedIn: boolean;
  policy: PolicyDecisionSnapshot;
  transcriptionMode: InferenceMode;
}

// Signing in from the prompt never switches a setting: a post-sign-in cloud switch is
// what overrode Local for #2086. Users whose dictation already runs on their own setup
// are told Cloud is available instead, once the account's policy says it is.
export function decideSignInCloudNudge({
  promptedAt,
  now,
  isSignedIn,
  policy,
  transcriptionMode,
}: SignInCloudNudgeInputs): SignInCloudNudgeDecision {
  if (Number.isNaN(promptedAt) || now - promptedAt > SIGN_IN_CLOUD_NUDGE_WINDOW_MS) return "skip";
  if (!isSignedIn || policy.status === "idle" || policy.status === "loading") return "wait";
  if (transcriptionMode === "openwhispr") return "skip";
  return isModeAllowedByPolicy(policy, "transcription", "openwhispr") ? "nudge" : "skip";
}
