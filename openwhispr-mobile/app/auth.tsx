import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import AuthScreen from '@/screens/AuthScreen';
import { requiresRealAccount } from '@/lib/accountAccess';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';

export default function AuthRoute() {
  const params = useLocalSearchParams<{ returnTo?: string; superwallPlacement?: string }>();
  const user = useAuthStore((state) => state.user);
  const isGuest = useAuthStore((state) => state.isGuest);
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
      // Also hidden for an anonymous session: the default guest action clears
      // the session, which would destroy their notes and any subscription.
      hideGuestContinue={isGuest || !!user}
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
