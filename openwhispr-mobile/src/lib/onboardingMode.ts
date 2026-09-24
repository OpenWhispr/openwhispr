import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { UserConfig } from '@/types';
import { dictationModeConfig } from './inferenceModes';
import { OnboardingError } from './onboardingErrors';

// updateConfig reports persistence errors in its store instead of rejecting.
// Onboarding must not advance until the user's preference is actually saved.
export async function saveOnboardingConfig(updates: Partial<UserConfig>): Promise<void> {
  await useConfigStore.getState().updateConfig(updates);
  const error = useConfigStore.getState().error;
  if (error) throw new Error(error);
}

export async function chooseOnboardingMode(
  mode: 'cloud' | 'private',
  from: 'privacy-mode' | 'private-download',
): Promise<void> {
  if (useOnboardingStore.getState().currentStep !== from) return;
  const auth = useAuthStore.getState();
  // Guests can't open a session during setup. On the download step Cloud is their only way past a
  // download that can't finish, so it's saved for after sign-in instead of refused.
  if (mode === 'cloud' && !auth.user && !(auth.isGuest && from === 'private-download')) {
    if (auth.isGuest)
      throw new OnboardingError(
        'Cloud needs an account. Use Local for now, or sign in after setup.',
      );
    await auth.ensureAnonymousSession();
    if (!useAuthStore.getState().user) {
      throw new OnboardingError(
        'Cloud needs a connection to set up. Try again or use Local for now.',
      );
    }
  }
  if (useOnboardingStore.getState().currentStep !== from) return;
  const config = useConfigStore.getState().config ?? null;
  const previous = { defaultMode: config?.defaultMode ?? 'cloud', inference: config?.inference };
  // The dictation route moves with the mode, so a replayed pick also leaves a Providers route.
  await saveOnboardingConfig(dictationModeConfig(config, mode));
  useProcessingModeStore.getState().resetToDefault(mode);
  try {
    await useOnboardingStore.getState().chooseMode(mode, from);
  } catch (error) {
    // Keep the active engine consistent with the screen when progress cannot be saved.
    useProcessingModeStore.getState().resetToDefault(previous.defaultMode);
    await saveOnboardingConfig(previous);
    throw error;
  }
}
