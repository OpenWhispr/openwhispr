import { useCallback } from "react";
import { resetOnboardingProgress } from "../components/onboarding/flow";

// Restart the onboarding flow from the cloud-migration step (used when a
// settings panel needs the user to sign in for OpenWhispr Cloud).
export function useStartOnboarding() {
  return useCallback(() => {
    localStorage.setItem("pendingCloudMigration", "true");
    resetOnboardingProgress(localStorage);
    window.location.reload();
  }, []);
}
