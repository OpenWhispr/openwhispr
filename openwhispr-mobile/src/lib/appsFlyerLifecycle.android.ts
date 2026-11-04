import type { AppsFlyerLifecycleDeps } from './appsFlyerLifecycle';

export function createAppsFlyerLifecycle(deps: AppsFlyerLifecycleDeps) {
  // A failed native transition must be retried when policy is reapplied.
  let stopped: boolean | null = false;
  let pending: Promise<boolean> | null = null;

  function setStopped(shouldStop: boolean): void {
    if (!deps.isInitialized() || shouldStop === stopped) return;
    stopped = shouldStop;
    const preferenceChange = deps.updateStopped(shouldStop);
    pending = preferenceChange;
    const readiness = preferenceChange.then((updated): boolean => {
      if (pending !== preferenceChange) return false;
      pending = null;
      if (!updated) {
        stopped = null;
        return false;
      }
      if (shouldStop || !deps.collectionAllowed()) return false;
      deps.startSession();
      deps.flushEvents();
      return true;
    });
    deps.setReadiness(shouldStop ? null : readiness);
    readiness.then((ready): void => {
      if (ready && deps.isCurrentReadiness(readiness)) deps.publishReady();
    });
  }

  return {
    canStartSession: () => stopped === false && pending === null,
    reapplyPolicyOnUnsupportedRefresh: true,
    setStopped,
  };
}
