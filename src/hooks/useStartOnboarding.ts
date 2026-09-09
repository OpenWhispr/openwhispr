import { useCallback } from "react";
import { resetOnboardingProgress } from "../components/onboarding/flow";

// Restart onboarding from the auth step so the user can sign in for OpenWhispr
// Cloud. The restarted flow's setup-choice step commits whatever the user picks
// via setCloudTranscriptionForAllScopes, so nothing is pre-armed here: a
// pre-armed cloud switch is what overrode Local for #2086.
export function useStartOnboarding(): () => void {
  return useCallback(() => {
    resetOnboardingProgress(localStorage);
    window.location.reload();
  }, []);
}
