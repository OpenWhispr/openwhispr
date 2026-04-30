import { useState, useCallback } from "react";
import { useSettingsStore, selectIsCloudCleanupMode } from "../stores/settingsStore";
import { useUsage } from "./useUsage";

interface UseNotesOnboardingReturn {
  isComplete: boolean;
  isProUser: boolean;
  isProLoading: boolean;
  isLLMConfigured: boolean;
  complete: () => void;
}

export function useNotesOnboarding(): UseNotesOnboardingReturn {
  const usage = useUsage();
  const isProUser = !!(usage?.isSubscribed || usage?.isTrial);
  const isProLoading = usage !== null && !usage.hasLoaded;
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);
  const effectiveModel = useSettingsStore((s) => s.cleanupModel);
  const isCloudCleanup = useSettingsStore(selectIsCloudCleanupMode);

  const [isComplete, setIsComplete] = useState(
    () => localStorage.getItem("notesOnboardingComplete") === "true"
  );

  const isLLMConfigured = isCloudCleanup || (useCleanupModel && !!effectiveModel);

  const complete = useCallback(() => {
    localStorage.setItem("notesOnboardingComplete", "true");
    localStorage.setItem("uploadSetupComplete", "true");
    setIsComplete(true);
  }, []);

  return { isComplete, isProUser, isProLoading, isLLMConfigured, complete };
}
