import { useCallback } from 'react';
import {
  getStepProgress,
  useOnboardingStore,
  type OnboardingStepId,
} from '@/store/useOnboardingStore';

export function useOnboardingStep(step: OnboardingStepId): {
  goNext: () => Promise<void>;
  goBack: () => Promise<void>;
  progress: ReturnType<typeof getStepProgress>;
} {
  const next = useOnboardingStore((state) => state.goNext);
  const back = useOnboardingStore((state) => state.goBack);
  const mode = useOnboardingStore((state) => state.selectedMode);
  return {
    goNext: useCallback(() => next(step), [next, step]),
    goBack: useCallback(() => back(step), [back, step]),
    progress: getStepProgress(step, mode),
  };
}
