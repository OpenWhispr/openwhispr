export interface AppsFlyerLifecycleDeps {
  isInitialized(): boolean;
  updateStopped(shouldStop: boolean): Promise<boolean>;
  setReadiness(readiness: Promise<boolean> | null): void;
  isCurrentReadiness(readiness: Promise<boolean>): boolean;
  collectionAllowed(): boolean;
  startSession(): void;
  flushEvents(): void;
  publishReady(): void;
}

export function createAppsFlyerLifecycle(deps: AppsFlyerLifecycleDeps) {
  let stopped = false;

  function setStopped(shouldStop: boolean): void {
    if (!deps.isInitialized() || shouldStop === stopped) return;
    stopped = shouldStop;
    const preferenceChange = deps.updateStopped(shouldStop);
    if (shouldStop) {
      deps.setReadiness(null);
      return;
    }
    const readiness = preferenceChange.then((updated): boolean => {
      if (!updated || stopped) return false;
      deps.startSession();
      deps.flushEvents();
      return true;
    });
    deps.setReadiness(readiness);
    readiness.then((ready): void => {
      if (ready && deps.isCurrentReadiness(readiness)) deps.publishReady();
    });
  }

  return {
    canStartSession: () => true,
    reapplyPolicyOnUnsupportedRefresh: false,
    setStopped,
  };
}
