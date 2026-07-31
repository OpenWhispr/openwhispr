import { useCallback } from "react";

// Restart the onboarding flow from the first step.
export function useStartOnboarding() {
  return useCallback(() => {
    localStorage.setItem("onboardingCurrentStep", "0");
    localStorage.removeItem("onboardingCompleted");
    window.location.reload();
  }, []);
}
