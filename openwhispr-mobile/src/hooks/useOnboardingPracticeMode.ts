import { useEffect } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

/**
 * Lets an onboarding practice step run on Cloud before the user has chosen a mode. Reports whether
 * Local is in effect instead, in which case the step shows an example rather than a live try.
 */
export function useOnboardingPracticeMode(): { localSelected: boolean } {
  const selectedMode = useOnboardingStore((state) => state.selectedMode);
  // Replaying onboarding starts with no choice made, but a saved Local default still stands.
  const savedMode = useConfigStore((state) => state.config?.defaultMode);
  const localSelected = (selectedMode ?? savedMode) === 'private';

  useEffect(() => {
    // Practice may use Cloud before the choice, but must never override a Local choice.
    if (selectedMode !== null || localSelected) return;
    const previous = useProcessingModeStore.getState();
    previous.setActiveMode('cloud', true);
    return () => {
      useProcessingModeStore.getState().setActiveMode(previous.activeMode, previous.isUserOverride);
    };
  }, [selectedMode, localSelected]);

  return { localSelected };
}
