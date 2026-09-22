import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { View } from 'react-native';
import AuthScreen from '@/screens/AuthScreen';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { describeOnboardingError } from '@/lib/onboardingErrors';
import { useAuthStore } from '@/store/useAuthStore';

// Account creation runs on an anonymous session, so "signed in" here has to
// mean a *real* account — otherwise the step would end the moment it mounted.
export function CreateAccountStep(): ReactElement {
  const { goNext } = useOnboardingStep('create-account');
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const hasContinuedRef = useRef(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  // The auth change that ends this step can re-render before the next step
  // mounts, so goNext() would otherwise fire more than once.
  // A retry keeps its error screen up until it succeeds, which unmounts this step.
  const continueOnce = useCallback(async (): Promise<void> => {
    if (hasContinuedRef.current) return;
    hasContinuedRef.current = true;
    try {
      await goNext();
    } catch (error) {
      // A failed keychain write must not latch this shut. The sign-in that ended
      // the step won't happen again, so the user needs a retry of their own.
      hasContinuedRef.current = false;
      setAdvanceError(describeOnboardingError(error, 'Could not save your progress. Try again.'));
    }
  }, [goNext]);

  useEffect(() => {
    // isGuest covers installs that never got an anonymous session.
    if ((user && !user.isAnonymous) || isGuest) continueOnce();
  }, [continueOnce, isGuest, user]);

  if (advanceError) {
    return (
      <OnboardingShell
        title="Almost there"
        subtitle={advanceError}
        ctaLabel="Retry"
        onCta={continueOnce}
      >
        <View className="flex-1" />
      </OnboardingShell>
    );
  }

  // The override exists to keep an anonymous session alive across the skip.
  // With no session there is nothing to keep, and advancing would only
  // re-render the same sign-in screen underneath; AuthScreen's default guest
  // action sets guest mode, which the effect above then finishes on.
  return <AuthScreen onGuestContinue={user ? continueOnce : undefined} />;
}
