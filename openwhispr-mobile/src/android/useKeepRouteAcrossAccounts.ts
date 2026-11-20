import { useEffect, useRef } from 'react';
import { router, useGlobalSearchParams, useSegments } from 'expo-router';
import { routeToRestore, type RestoredRoute } from './accountRoute';

function onboardingDone(): boolean {
  try {
    return localStorage.getItem('android-onboarding-done') === 'true';
  } catch {
    return true;
  }
}

/**
 * Reopens a screen that holds no account data after Root rebuilds the navigator for a new
 * account (see accountRoute.ts). Home goes underneath it, so its Back still has somewhere to go.
 */
export function useKeepRouteAcrossAccounts(accountRevision: number): void {
  const segments = useSegments();
  const params = useGlobalSearchParams();
  const current = useRef<RestoredRoute | null>(null);
  const seen = useRef(accountRevision);

  // The latest screen, read when the account changes, before the rebuilt navigator reports in.
  current.current = routeToRestore(segments, params);

  useEffect(() => {
    if (accountRevision === seen.current) return;
    seen.current = accountRevision;
    const target = current.current;
    if (!target) return;
    // Let the rebuilt navigator mount first.
    const timer = setTimeout(() => {
      if (onboardingDone()) router.replace('/(tabs)/(record)');
      router.push(target as never);
    }, 0);
    return () => clearTimeout(timer);
  }, [accountRevision]);
}
