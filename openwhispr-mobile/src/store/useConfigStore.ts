import { create } from 'zustand';
import { UserConfig } from '../types';
import { StorageService } from '../services/storage/StorageService';
import {
  localModeUpgradeConfig,
  noteChatSplitConfig,
  notesLocalModeSplitConfig,
} from '../lib/inferenceModes';
import { withoutRetiredModels } from '../lib/retiredModels';
import { useProcessingModeStore } from './useProcessingModeStore';

interface ConfigState {
  config: UserConfig | null;
  isLoading: boolean;
  error: string | null;
  loadConfig: () => Promise<void>;
  updateConfig: (config: Partial<UserConfig>) => Promise<void>;
  resetConfig: () => Promise<void>;
}

const defaultConfig: UserConfig = {
  defaultMode: 'cloud',
  appleLocalIntelligenceEnabled: true,
  localModeUpgraded: true,
  noteChatSplit: true,
  notesLocalModeSplit: true,
};

let configUpdate: Promise<void> | null = null;
let pendingUpdates = 0;
let analyticsConsentRevision = 0;
let analyticsConsentOverride: boolean | null = null;
let analyticsPersistenceError: string | null = null;

function withCurrentConsent(config: UserConfig): UserConfig {
  return analyticsConsentOverride === null
    ? config
    : { ...config, usageAnalyticsEnabled: analyticsConsentOverride };
}

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
  // Subscribers can synchronously enqueue another change, so reserve our place first.
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

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  loadConfig: () => {
    pendingUpdates += 1;
    return enqueueConfigOperation(
      async () => {
        try {
          const config = await StorageService.getConfig();
          // A config from before Local Mode's Cloud defaults is upgraded before anything reads it, so
          // its uploads and cleanup never reach Cloud; one from before note chat had a selection of its
          // own keeps the one it shared; and one from before note formatting left Local Mode keeps its
          // notes on this iPhone. A selection of a model its provider shut down moves to the
          // replacement. A failed save upgrades it again next launch.
          const localModeConfig =
            !config || config.localModeUpgraded
              ? config
              : { ...config, ...localModeUpgradeConfig(config) };
          const noteChatConfig =
            !localModeConfig || localModeConfig.noteChatSplit
              ? localModeConfig
              : { ...localModeConfig, ...noteChatSplitConfig(localModeConfig) };
          const resolvedConfig = withoutRetiredModels(
            !noteChatConfig
              ? defaultConfig
              : noteChatConfig.notesLocalModeSplit
                ? noteChatConfig
                : { ...noteChatConfig, ...notesLocalModeSplitConfig(noteChatConfig) },
          );
          if (config && resolvedConfig !== config) {
            await StorageService.saveConfig(withCurrentConsent(resolvedConfig)).catch(
              () => undefined,
            );
          }
          useProcessingModeStore.getState().resetToDefault(resolvedConfig.defaultMode);
          set({ config: withCurrentConsent(resolvedConfig), error: analyticsPersistenceError });
        } catch (error) {
          set({
            error: analyticsPersistenceError ?? (error as Error).message,
            config: withCurrentConsent(defaultConfig),
          });
          useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
        } finally {
          pendingUpdates -= 1;
          set({ isLoading: pendingUpdates > 0 });
        }
      },
      () => set({ isLoading: true, error: analyticsPersistenceError }),
    );
  },

  updateConfig: (updates: Partial<UserConfig>) => {
    if (updates.usageAnalyticsEnabled !== undefined) analyticsConsentRevision += 1;
    if (updates.usageAnalyticsEnabled === false) analyticsConsentOverride = false;
    const consentRevision = analyticsConsentRevision;
    pendingUpdates += 1;

    const preserveNewerConsent = (config: UserConfig): UserConfig =>
      consentRevision === analyticsConsentRevision ? config : withCurrentConsent(config);

    const save = async () => {
      const newConfig = preserveNewerConsent({ ...(get().config || defaultConfig), ...updates });
      try {
        await StorageService.saveConfig(newConfig);
        if (
          consentRevision === analyticsConsentRevision &&
          updates.usageAnalyticsEnabled === true
        ) {
          analyticsConsentOverride = true;
        }
        if (newConfig.usageAnalyticsEnabled === analyticsConsentOverride) {
          analyticsPersistenceError = null;
        }
        const modeStore = useProcessingModeStore.getState();
        if (!modeStore.isUserOverride) {
          modeStore.resetToDefault(newConfig.defaultMode);
        }
        set({ config: withCurrentConsent(newConfig), error: analyticsPersistenceError });
      } catch (error) {
        if (analyticsConsentOverride === false)
          analyticsPersistenceError = (error as Error).message;
        set({ error: (error as Error).message });
      } finally {
        pendingUpdates -= 1;
        set({ isLoading: pendingUpdates > 0 });
      }
    };

    // An older disk write must not finish after a newer consent withdrawal.
    return enqueueConfigOperation(save, () => {
      // Withdrawal takes effect before storage; granting consent requires a successful save.
      set({
        ...(updates.usageAnalyticsEnabled === false && {
          config: { ...(get().config || defaultConfig), usageAnalyticsEnabled: false },
        }),
        isLoading: true,
        error: null,
      });
    });
  },

  resetConfig: () => {
    const consentRevision = ++analyticsConsentRevision;
    pendingUpdates += 1;
    return enqueueConfigOperation(
      async () => {
        try {
          await StorageService.clearConfig();
          if (consentRevision === analyticsConsentRevision) {
            analyticsConsentOverride = null;
            analyticsPersistenceError = null;
          }
          useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
          set({ config: withCurrentConsent(defaultConfig), error: analyticsPersistenceError });
        } catch (error) {
          if (analyticsConsentOverride === false)
            analyticsPersistenceError = (error as Error).message;
          set({ error: (error as Error).message });
        } finally {
          pendingUpdates -= 1;
          set({ isLoading: pendingUpdates > 0 });
        }
      },
      () => set({ isLoading: true, error: null }),
    );
  },
}));
