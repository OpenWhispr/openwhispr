import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { ProcessingMode, UserConfig } from '@/types';

// updateConfig reports persistence errors in its store instead of rejecting.
// Onboarding must not advance until the user's preference is actually saved.
export async function saveOnboardingConfig(updates: Partial<UserConfig>): Promise<void> {
  await useConfigStore.getState().updateConfig(updates);
  const error = useConfigStore.getState().error;
  if (error) throw new Error(error);
}

export async function chooseOnboardingMode(
  mode: ProcessingMode,
  from: 'privacy-mode' | 'private-download',
): Promise<void> {
  if (useOnboardingStore.getState().currentStep !== from) return;
  if (mode === 'cloud' && !useAuthStore.getState().user) {
    const auth = useAuthStore.getState();
    if (auth.isGuest)
      throw new Error('Cloud needs an account. Use Local for now, or sign in after setup.');
    await auth.ensureAnonymousSession();
    if (!useAuthStore.getState().user) {
      throw new Error('Cloud needs a connection to set up. Try again or use Local for now.');
    }
  }
  if (useOnboardingStore.getState().currentStep !== from) return;
  const previousMode = useConfigStore.getState().config?.defaultMode ?? 'cloud';
  await saveOnboardingConfig({ defaultMode: mode });
  useProcessingModeStore.getState().resetToDefault(mode);
  try {
    await useOnboardingStore.getState().chooseMode(mode, from);
  } catch (error) {
    // Keep the active engine consistent with the screen when progress cannot be saved.
    useProcessingModeStore.getState().resetToDefault(previousMode);
    await saveOnboardingConfig({ defaultMode: previousMode });
    throw error;
  }
}
