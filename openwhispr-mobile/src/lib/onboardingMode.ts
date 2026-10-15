import { Platform } from 'react-native';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { hasRealAccountHistory } from '@/sync/syncIdentity';
import type { LocalReasoningReadiness, UserConfig } from '@/types';
import type { InferenceSelection } from './mobileProviders';
import { PRIVATE_MODE_LOCKED } from './aiWorkflows';
import { dictationModeConfig } from './inferenceModes';
import { canRunLocalReasoning, getLocalReasoningReadiness } from './localReasoning';
import { OnboardingError } from './onboardingErrors';

// updateConfig reports persistence errors in its store instead of rejecting.
// Onboarding must not advance until the user's preference is actually saved.
export async function saveOnboardingConfig(updates: Partial<UserConfig>): Promise<void> {
  await useConfigStore.getState().updateConfig(updates);
  const error = useConfigStore.getState().error;
  if (error) throw new Error(error);
}

// Private mode skips cleanup until it has a selection of its own, and nobody choosing Private mode
// in setup would know to go save one. So setup saves On-Device cleanup on an iPhone that runs
// Apple Intelligence, even while it's off or still preparing. Where it can't tell yet (an older
// iOS, which an update may fix, Apple Intelligence turned off in AI Models, or readiness it can't
// read), it marks cleanup pending for applyPendingOnDeviceCleanup. An iPhone that can never run
// it, or Android, keeps cleanup unset (skipped). A selection already saved is left alone, unless
// it is Cloud, which Private mode never runs.
function onboardingCleanup(
  config: UserConfig | null,
  mode: 'cloud' | 'private',
  readiness: LocalReasoningReadiness | null,
): { cleanup?: InferenceSelection; pending: boolean } {
  const saved = config?.inference?.cleanup;
  if (mode === 'private') {
    if (saved && !PRIVATE_MODE_LOCKED.cleanup?.includes(saved.mode)) {
      return { cleanup: saved, pending: false };
    }
    if (canRunLocalReasoning(readiness)) return { cleanup: { mode: 'local' }, pending: false };
    return {
      cleanup: saved,
      pending: !saved && Platform.OS === 'ios' && readiness?.status !== 'unsupportedDevice',
    };
  }
  // Back to Cloud after choosing Private mode earlier in setup drops the On-Device cleanup that
  // choice saved, so Cloud dictation gets Cloud cleanup.
  const savedBySetup =
    useOnboardingStore.getState().selectedMode === 'private' &&
    saved?.mode === 'local' &&
    Object.keys(saved).length === 1;
  return { cleanup: savedBySetup ? undefined : saved, pending: false };
}

// Saves the On-Device cleanup setup couldn't (onDeviceCleanupPending) once a launch finds Apple
// Intelligence can run, while Private mode is still on and cleanup was never set. Outside Private
// mode it waits, since unset cleanup there runs on Cloud.
export async function applyPendingOnDeviceCleanup(): Promise<void> {
  const { config, updateConfig } = useConfigStore.getState();
  if (!config?.onDeviceCleanupPending) return;
  if (config.inference?.cleanup) {
    await updateConfig({ onDeviceCleanupPending: undefined });
    return;
  }
  if (config.defaultMode !== 'private') return;
  // A fresh read: the last one may predate an iOS update.
  const readiness = await getLocalReasoningReadiness({ refresh: true });
  // Updated, and it turns out this iPhone can never run it: nothing is left to wait for.
  if (readiness.status === 'unsupportedDevice') {
    await updateConfig({ onDeviceCleanupPending: undefined });
    return;
  }
  if (!canRunLocalReasoning(readiness)) return;
  const latest = useConfigStore.getState().config;
  if (!latest?.onDeviceCleanupPending || latest.defaultMode !== 'private') return;
  await updateConfig({
    onDeviceCleanupPending: undefined,
    ...(latest.inference?.cleanup
      ? {}
      : { inference: { ...latest.inference, cleanup: { mode: 'local' } } }),
  });
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
            ? 'Cloud needs an account. Use Private Mode for now, or sign in after setup.'
            : 'Cloud needs you signed in. Use Private Mode for now, or sign in after setup.',
        );
    } else {
      await auth.ensureAnonymousSession();
      if (!useAuthStore.getState().user) {
        throw new OnboardingError(
          'Cloud needs a connection to set up. Try again or use Private Mode for now.',
        );
      }
    }
  }
  const readiness = mode === 'private' ? await getLocalReasoningReadiness() : null;
  if (useOnboardingStore.getState().currentStep !== from) return;
  const config = useConfigStore.getState().config ?? null;
  const previous = {
    defaultMode: config?.defaultMode ?? 'cloud',
    inference: config?.inference,
    pinnedInference: config?.pinnedInference,
    onDeviceCleanupPending: config?.onDeviceCleanupPending,
  };
  // The dictation route moves with the mode, so a replayed pick also leaves a Providers route.
  const next = dictationModeConfig(config, mode);
  const inference = { ...next.inference };
  const { cleanup, pending } = onboardingCleanup(config, mode, readiness);
  if (cleanup) inference.cleanup = cleanup;
  else delete inference.cleanup;
  await saveOnboardingConfig({
    ...next,
    inference,
    ...(pending
      ? { onDeviceCleanupPending: true }
      : config?.onDeviceCleanupPending
        ? { onDeviceCleanupPending: undefined }
        : {}),
  });
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
