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
  // Requested is what sign-out must undo, even while a login is pending or after
  // it failed (the native call may still land). Identified gates a retry, and
  // only the latest attempt may set it: an older one can succeed after a
  // sign-out has since logged the SDK out.
  const requestedUserIdRef = useRef<string | null>(null);
  const identifiedUserIdRef = useRef<string | null>(null);
  const identifyAttemptRef = useRef(0);

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
      if (requestedUserIdRef.current !== billingUserId) identifiedUserIdRef.current = null;
      requestedUserIdRef.current = billingUserId;
      if (identifiedUserIdRef.current === billingUserId) return;
      const attempt = ++identifyAttemptRef.current;
      identifyRevenueCatUser(billingUserId).then((identified) => {
        if (identified && attempt === identifyAttemptRef.current) {
          identifiedUserIdRef.current = billingUserId;
        }
      });
      return;
    }

    if (requestedUserIdRef.current) {
      identifyAttemptRef.current += 1;
      requestedUserIdRef.current = null;
      identifiedUserIdRef.current = null;
      resetRevenueCatUser();
    }
  }, [billingUserId, isInitialized, user, isGuest]);
}
