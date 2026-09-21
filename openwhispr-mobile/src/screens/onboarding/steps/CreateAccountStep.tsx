import { useCallback, useEffect, useRef, type ReactElement } from 'react';
import AuthScreen from '@/screens/AuthScreen';
import { Sentry } from '@/lib/sentry';
import { useAuthStore } from '@/store/useAuthStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';

// Account creation runs on an anonymous session, so "signed in" here has to
// mean a *real* account — otherwise the step would end the moment it mounted.
export function CreateAccountStep(): ReactElement {
  const goNext = useOnboardingStore((s) => s.goNext);
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const hasContinuedRef = useRef(false);

  // The auth change that ends this step can re-render before the next step
  // mounts, so goNext() would otherwise fire more than once.
  const continueOnce = useCallback(() => {
    if (hasContinuedRef.current) return;
    hasContinuedRef.current = true;
    goNext().catch((error: unknown) => {
      // A failed keychain write must not latch this shut: the user would sit
      // on a sign-in screen with no way forward. Report it and allow a retry.
      hasContinuedRef.current = false;
      Sentry.captureException(error);
    });
  }, [goNext]);

  useEffect(() => {
    // isGuest covers installs that never got an anonymous session.
    if ((user && !user.isAnonymous) || isGuest) continueOnce();
  }, [continueOnce, isGuest, user]);

  // The override exists to keep an anonymous session alive across the skip.
  // With no session there is nothing to keep, and advancing would only
  // re-render the same sign-in screen underneath; AuthScreen's default guest
  // action sets guest mode, which the effect above then finishes on.
  return <AuthScreen onGuestContinue={user ? continueOnce : undefined} />;
}
