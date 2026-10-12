import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useAuthStore } from '@/store/useAuthStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { hasRealAccountHistory } from '@/sync/syncIdentity';
import { FIRST_ONBOARDING_STEP } from '@/utils/onboarding';

/**
 * Onboarding runs before signup, so open an anonymous server session for it.
 * Cloud transcription, usage limits and the paywall all authenticate per user,
 * and this gives a pre-signup user a real one — signing up later links to it.
 *
 * Gated on onboarding hydration: `finished` is false until it resolves, so
 * acting earlier could mint a session for a returning, already-onboarded user
 * who signed out and should be seeing AuthScreen.
 *
 * Best-effort: a first launch offline gets no session, and nothing in the
 * store changes on that failure, so retry on each return to the foreground
 * until one lands. The store dedupes concurrent attempts.
 */
export function useAnonymousOnboardingSession(): void {
  const ensureAnonymousSession = useAuthStore((state) => state.ensureAnonymousSession);
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const user = useAuthStore((state) => state.user);
  const onboardingHydrated = useOnboardingStore((state) => state.hydrated);
  const onboardingFinished = useOnboardingStore((state) => state.finished);
  const currentStep = useOnboardingStore((state) => state.currentStep);

  useEffect(() => {
    if (!isInitialized || !onboardingHydrated || onboardingFinished || user) return;
    // Nothing before the dictation demo needs a session, and a row minted
    // behind the splash would outlive someone who opens the app once and
    // deletes it. Wait until the user has actually started.
    if (currentStep === FIRST_ONBOARDING_STEP) return;
    // "Reset onboarding" on a device that synced a real account replays the
    // flow as a demo; a new identity there would read as an account switch
    // and wipe that account's local notes.
    if (hasRealAccountHistory()) return;
    ensureAnonymousSession();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') ensureAnonymousSession();
    });
    return () => subscription.remove();
  }, [
    currentStep,
    ensureAnonymousSession,
    isInitialized,
    onboardingHydrated,
    onboardingFinished,
    user,
  ]);
}
