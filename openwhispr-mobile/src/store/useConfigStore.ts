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

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  loadConfig: async () => {
    set({ isLoading: true, error: null });
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
        await StorageService.saveConfig(resolvedConfig).catch(() => undefined);
      }
      useProcessingModeStore.getState().resetToDefault(resolvedConfig.defaultMode);
      set({ config: resolvedConfig, isLoading: false });
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
        config: defaultConfig,
      });
      useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
    }
  },

  updateConfig: (updates: Partial<UserConfig>) => {
    if (updates.usageAnalyticsEnabled !== undefined) analyticsConsentRevision += 1;
    const consentRevision = analyticsConsentRevision;
    pendingUpdates += 1;

    // Withdrawal takes effect before storage; granting consent still requires a successful save.
    set({
      ...(updates.usageAnalyticsEnabled === false && {
        config: { ...(get().config || defaultConfig), usageAnalyticsEnabled: false },
      }),
      isLoading: true,
      error: null,
    });

    const preserveNewerConsent = (config: UserConfig): UserConfig =>
      consentRevision === analyticsConsentRevision
        ? config
        : { ...config, usageAnalyticsEnabled: get().config?.usageAnalyticsEnabled };

    const save = async () => {
      const newConfig = preserveNewerConsent({ ...(get().config || defaultConfig), ...updates });
      try {
        await StorageService.saveConfig(newConfig);
        const modeStore = useProcessingModeStore.getState();
        if (!modeStore.isUserOverride) {
          modeStore.resetToDefault(newConfig.defaultMode);
        }
        set({ config: preserveNewerConsent(newConfig), error: null });
      } catch (error) {
        set({ error: (error as Error).message });
      } finally {
        pendingUpdates -= 1;
        set({ isLoading: pendingUpdates > 0 });
      }
    };

    // An older disk write must not finish after a newer consent withdrawal.
    const operation = configUpdate ? configUpdate.then(save) : save();
    configUpdate = operation;
    return operation.finally(() => {
      if (configUpdate === operation) configUpdate = null;
    });
  },

  resetConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      await StorageService.clearConfig();
      useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
      set({ config: defaultConfig, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },
}));
