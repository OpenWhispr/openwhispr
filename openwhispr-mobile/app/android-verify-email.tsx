import { router, useLocalSearchParams } from 'expo-router';
import { VerifyLinkScreen } from '@/android/auth/VerifyLinkScreen';

/**
 * The verify-email link: https://openwhispr.com/android-verify-email?token=…, sent to Android
 * sign-ups (openwhispr-api lib/verification-url.ts). Android opens it here as an App Link.
 */
export default function AndroidVerifyEmailRoute() {
  const params = useLocalSearchParams<{ token?: string }>();
  return (
    <VerifyLinkScreen
      token={typeof params.token === 'string' && params.token ? params.token : undefined}
      // "/" sends someone still in onboarding back to it, and everyone else Home.
      onContinue={() => router.replace('/')}
      onSignIn={() => router.replace('/auth')}
    />
  );
}
