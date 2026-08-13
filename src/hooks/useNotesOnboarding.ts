import { useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  selectIsCloudCleanupMode,
  selectPolicyEffectiveSettings,
  useSettingsStore,
} from "../stores/settingsStore";
import { useUsage } from "./useUsage";
import { usePolicySnapshot } from "./usePolicy";

interface UseNotesOnboardingReturn {
  isComplete: boolean;
  isProUser: boolean;
  isProLoading: boolean;
  isLLMConfigured: boolean;
  complete: () => void;
}

export function useNotesOnboarding(): UseNotesOnboardingReturn {
  const usage = useUsage();
  const isProUser = usage?.hasPaidAccess === true;
  const isProLoading = usage !== null && usage.status !== "success";
  const policyState = usePolicySnapshot();
  const { useCleanupModel, effectiveModel, isCloudCleanup } = useSettingsStore(
    useShallow((settings) => {
      const effective = selectPolicyEffectiveSettings(settings, policyState);
      return {
        useCleanupModel: effective.useCleanupModel,
        effectiveModel: effective.cleanupModel,
        isCloudCleanup: selectIsCloudCleanupMode(effective),
      };
    })
  );

  const [isComplete, setIsComplete] = useState(
    () => localStorage.getItem("notesOnboardingComplete") === "true"
  );

  const isLLMConfigured = isCloudCleanup || (useCleanupModel && !!effectiveModel);

  const complete = useCallback(() => {
    localStorage.setItem("notesOnboardingComplete", "true");
    setIsComplete(true);
  }, []);

  return { isComplete, isProUser, isProLoading, isLLMConfigured, complete };
}
