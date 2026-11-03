import { Platform } from 'react-native';
import { canRunLocalReasoning, getLocalReasoningReadiness } from './localReasoning';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { hasRealAccountHistory } from '@/sync/syncIdentity';
import type { UserConfig } from '@/types';
import { dictationModeConfig, holdOnDeviceConfig } from './inferenceModes';
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
  if (mode === 'cloud' && !auth.user) {
    // Guests declined an account, and a device that synced one must not get a new identity (its
    // first sync would read as an account switch and wipe that account's notes), so neither opens
    // a session during setup. On the download step Cloud is their only way past a download that
    // can't finish, so it's saved for after sign-in instead of refused.
    if (auth.isGuest || hasRealAccountHistory()) {
      if (from !== 'private-download')
        throw new OnboardingError(
          auth.isGuest
            ? 'Cloud needs an account. Use Local Mode for now, or sign in after setup.'
            : 'Cloud needs you signed in. Use Local Mode for now, or sign in after setup.',
        );
    } else {
      await auth.ensureAnonymousSession();
      if (!useAuthStore.getState().user) {
        throw new OnboardingError(
          'Cloud needs a connection to set up. Try again or use Local Mode for now.',
        );
      }
    }
  }
  const androidReadiness =
    Platform.OS === 'android' && mode === 'private' ? await getLocalReasoningReadiness() : null;
  if (useOnboardingStore.getState().currentStep !== from) return;
  const config = useConfigStore.getState().config ?? null;
  const previous = {
    defaultMode: config?.defaultMode ?? 'cloud',
    inference: config?.inference,
    pinnedInference: config?.pinnedInference,
  };
  // The dictation route moves with the mode, so a replayed pick also leaves a Providers route.
  // Choosing Local in setup also keeps uploads and cleanup on this iPhone; choosing Cloud releases
  // them. The other workflows follow the picked mode until a Dictation change in AI Models holds
  // them where they ran.
  const next = dictationModeConfig(config, mode);
  if (Platform.OS === 'android') {
    const saved = config?.inference?.cleanup;
    if (
      mode === 'private' &&
      (!saved || saved.mode === 'openwhispr') &&
      canRunLocalReasoning(androidReadiness)
    ) {
      next.inference = { ...next.inference, cleanup: { mode: 'local' } };
    } else if (
      mode === 'cloud' &&
      useOnboardingStore.getState().selectedMode === 'private' &&
      saved?.mode === 'local' &&
      Object.keys(saved).length === 1
    ) {
      // Drop only the plain cleanup choice saved by Android setup when that setup returns to Cloud.
      next.inference = { ...next.inference };
      delete next.inference.cleanup;
    }
  }
  await saveOnboardingConfig(
    Platform.OS !== 'android' && mode === 'private'
      ? { ...next, ...holdOnDeviceConfig({ ...config, ...next }) }
      : next,
  );
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
