import { router, useLocalSearchParams } from 'expo-router';
import { ResetPasswordScreen } from '@/android/auth/ResetPasswordScreen';

function onboardingDone(): boolean {
  try {
    return localStorage.getItem('android-onboarding-done') === 'true';
  } catch {
    return true;
  }
}

/**
 * The reset email's link: https://openwhispr.com/android-reset-password?token=… (or
 * ?error=INVALID_TOKEN). Android opens it here as an App Link; see passwordReset.ts.
 */
export default function AndroidResetPasswordRoute() {
  const params = useLocalSearchParams<{ token?: string; error?: string }>();
  // "/" sends someone still in onboarding back to it, and everyone else Home.
  const leave = (signIn: boolean) => router.replace(signIn && onboardingDone() ? '/auth' : '/');
  return (
    <ResetPasswordScreen
      token={typeof params.token === 'string' && params.token ? params.token : undefined}
      invalid={params.error === 'INVALID_TOKEN'}
      onSignIn={() => leave(true)}
      onContinue={() => leave(false)}
    />
  );
}
