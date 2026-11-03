import type { UserConfig } from '../types';
import type { ConfigStoreContext, ConfigStoreLifecycle } from '../store/createConfigStore';

export function createAndroidConfigLifecycle({
  set,
  get,
  defaultConfig,
}: ConfigStoreContext): ConfigStoreLifecycle {
  let configUpdate: Promise<void> | null = null;
  let pendingUpdates = 0;
  let analyticsConsentRevision = 0;
  let analyticsConsentOverride: boolean | null = null;
  let analyticsPersistenceError: string | null = null;
  const withCurrentConsent = (config: UserConfig): UserConfig =>
    analyticsConsentOverride === null
      ? config
      : { ...config, usageAnalyticsEnabled: analyticsConsentOverride };

  function enqueueConfigOperation(
    operation: () => Promise<void>,
    publish: () => void,
  ): Promise<void> {
    const previous = configUpdate;
    let start!: () => void;
    const result = new Promise<void>((resolve, reject) => {
      start = () => {
        operation().then(resolve, reject);
      };
    });
    // Reserve the queue position before subscribers can enqueue another change.
    configUpdate = result;
    let publicationFailure: { error: unknown } | undefined;
    try {
      publish();
    } catch (error) {
      publicationFailure = { error };
    }
    if (previous) previous.then(start, start);
    else start();
    return result
      .finally(() => {
        if (configUpdate === result) configUpdate = null;
      })
      .then(() => {
        if (publicationFailure) throw publicationFailure.error;
      });
  }
  const finish = () => {
    pendingUpdates -= 1;
    set({ isLoading: pendingUpdates > 0 });
  };
  const success = (config: UserConfig) => ({
    config: withCurrentConsent(config),
    error: analyticsPersistenceError,
  });
  const failure = (error: unknown) => {
    if (analyticsConsentOverride === false) analyticsPersistenceError = (error as Error).message;
    return { error: (error as Error).message };
  };
  return {
    load: () => {
      pendingUpdates += 1;
      return {
        enqueue: (operation) =>
          enqueueConfigOperation(operation, () =>
            set({ isLoading: true, error: analyticsPersistenceError }),
          ),
        configForSave: withCurrentConsent,
        success,
        failure: (error) => ({
          error: analyticsPersistenceError ?? (error as Error).message,
          config: withCurrentConsent(defaultConfig),
        }),
        finish,
      };
    },
    update: (updates) => {
      if (updates.usageAnalyticsEnabled !== undefined) analyticsConsentRevision += 1;
      if (updates.usageAnalyticsEnabled === false) analyticsConsentOverride = false;
      const consentRevision = analyticsConsentRevision;
      pendingUpdates += 1;
      return {
        enqueue: (operation) =>
          enqueueConfigOperation(operation, () => {
            // Withdrawal is immediate; opt-in requires successful persistence.
            set({
              ...(updates.usageAnalyticsEnabled === false && {
                config: { ...(get().config || defaultConfig), usageAnalyticsEnabled: false },
              }),
              isLoading: true,
              error: null,
            });
          }),
        configForSave: (config) =>
          consentRevision === analyticsConsentRevision ? config : withCurrentConsent(config),
        didPersist: (config) => {
          if (
            consentRevision === analyticsConsentRevision &&
            updates.usageAnalyticsEnabled === true
          )
            analyticsConsentOverride = true;
          if (config.usageAnalyticsEnabled === analyticsConsentOverride)
            analyticsPersistenceError = null;
        },
        success,
        failure,
        finish,
      };
    },
    reset: () => {
      const consentRevision = ++analyticsConsentRevision;
      pendingUpdates += 1;
      return {
        enqueue: (operation) =>
          enqueueConfigOperation(operation, () => set({ isLoading: true, error: null })),
        configForSave: withCurrentConsent,
        didPersist: () => {
          if (consentRevision === analyticsConsentRevision) {
            analyticsConsentOverride = null;
            analyticsPersistenceError = null;
          }
        },
        success,
        failure,
        finish,
      };
    },
  };
}
