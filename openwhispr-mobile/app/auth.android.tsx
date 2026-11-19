import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import AuthScreen, { isAuthReason } from '@/screens/AuthScreen.android';
import { requiresRealAccount } from '@/lib/accountAccess';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore.android';

export default function AuthRoute() {
  const params = useLocalSearchParams<{
    returnTo?: string;
    superwallPlacement?: string;
    reason?: string;
  }>();
  const user = useAuthStore((state) => state.user);
  const sessionRejected = useUsageStore((state) => state.sessionRejected);

  useEffect(() => {
    // An anonymous session is here to become an account; only a real one is
    // done and gets sent on.
    // Android retains the local account while a rejected cloud session is
    // replaced. Do not dismiss its sign-in screen before that succeeds.
    if (requiresRealAccount(user) || sessionRejected) return;
    if (params.returnTo === 'account') {
      const placement = params.superwallPlacement
        ? `?superwallPlacement=${encodeURIComponent(params.superwallPlacement)}`
        : '';
      router.replace(`/(account)${placement}`);
      return;
    }
    router.replace('/(tabs)/(record)');
  }, [params.returnTo, params.superwallPlacement, user, sessionRejected]);

  return (
    <AuthScreen
      reason={isAuthReason(params.reason) ? params.reason : undefined}
      // The server refused this account's session: sign it in again (2.5), keeping its notes.
      signInAgainEmail={sessionRejected && user && !user.isAnonymous ? user.email : undefined}
      // In the app someone is already using OpenWhispr without an account, so there is no guest
      // link (1.2); for an anonymous session it would also clear the session, notes and all.
      hideGuestContinue
      onClose={() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(tabs)/(record)');
        }
      }}
    />
  );
}
