import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { configureRevenueCat, identifyRevenueCatUser, resetRevenueCatUser } from '@/lib/revenuecat';

// Keeps RevenueCat's app user id aligned with the stable public billing UUID so
// observer-mode purchases and server reconciliation use the same identity. Guests stay
// anonymous — they can't purchase without signing in first.
export function useRevenueCatIdentity(): void {
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const user = useAuthStore((state) => state.user);
  const isGuest = useAuthStore((state) => state.isGuest);
  const billingUserId = useUsageStore((state) => state.usage?.billingUserId ?? null);
  const identifiedUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    configureRevenueCat();
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    if (user && !isGuest) {
      // Usage is reset on every sign-in, so billingUserId is briefly null while
      // the user stays signed in. Waiting rather than falling through avoids a
      // logOut/logIn round trip onto a throwaway anonymous RevenueCat id at the
      // exact moment a purchase is being attributed. Mirrors the same guard in
      // SuperwallEntitlementBridge.
      if (!billingUserId) return;
      if (identifiedUserIdRef.current === billingUserId) return;
      let cancelled = false;
      identifyRevenueCatUser(billingUserId).then((identified) => {
        if (identified && !cancelled) identifiedUserIdRef.current = billingUserId;
      });
      return () => {
        cancelled = true;
      };
    }

    if (identifiedUserIdRef.current) {
      identifiedUserIdRef.current = null;
      resetRevenueCatUser();
    }
  }, [billingUserId, isInitialized, user, isGuest]);
}
