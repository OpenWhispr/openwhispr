import { useCallback } from "react";

// Restart the onboarding flow from the cloud-migration step (used when a
// settings panel needs the user to sign in for OpenWhispr Cloud).
export function useStartOnboarding() {
  return useCallback(() => {
    localStorage.setItem("pendingCloudMigration", "true");
    localStorage.setItem("onboardingCurrentStep", "0");
    localStorage.removeItem("onboardingCompleted");
    window.location.reload();
  }, []);
}
