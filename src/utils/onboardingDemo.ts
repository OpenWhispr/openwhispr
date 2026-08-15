import type { OnboardingDemoKind } from "../types/electron";

export function getOnboardingDemoKind(voiceAgentRequested: boolean): OnboardingDemoKind {
  return voiceAgentRequested ? "assistant" : "dictation";
}
