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
  minimalKeyboardEnabled: false,
  appleLocalIntelligenceEnabled: true,
  localModeUpgraded: true,
  noteChatSplit: true,
  notesLocalModeSplit: true,
};

let pendingConfigOperation: Promise<void> = Promise.resolve();

function serializeConfigOperation<Arguments extends unknown[]>(
  operation: (...args: Arguments) => Promise<void>,
): (...args: Arguments) => Promise<void> {
  return (...args): Promise<void> => {
    const result = pendingConfigOperation.then(() => operation(...args));
    pendingConfigOperation = result.catch(() => undefined);
    return result;
  };
}

async function prepareConfigChange(
  currentConfig: UserConfig | null,
  nextConfig: UserConfig,
): Promise<void> {
  // Keep the saved opt-out as the restart fence until its old queue is erased.
  if (
    currentConfig?.usageAnalyticsEnabled === false &&
    nextConfig.usageAnalyticsEnabled !== false
  ) {
    const { prepareProductEventsOptIn } =
      require('../lib/productEvents') as typeof import('../lib/productEvents');
    await prepareProductEventsOptIn();
  }
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  loadConfig: serializeConfigOperation(async () => {
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
        config: { ...defaultConfig, usageAnalyticsEnabled: false },
      });
      useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
    }
  }),

  updateConfig: serializeConfigOperation(async (updates: Partial<UserConfig>) => {
    const currentConfig = get().config || defaultConfig;
    const newConfig = { ...currentConfig, ...updates };

    set({ isLoading: true, error: null });
    try {
      await prepareConfigChange(currentConfig, newConfig);
      await StorageService.saveConfig(newConfig);
      const modeStore = useProcessingModeStore.getState();
      if (!modeStore.isUserOverride) {
        modeStore.resetToDefault(newConfig.defaultMode);
      }
      set({ config: newConfig, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  }),

  resetConfig: serializeConfigOperation(async () => {
    set({ isLoading: true, error: null });
    try {
      await prepareConfigChange(get().config, defaultConfig);
      await StorageService.clearConfig();
      useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
      set({ config: defaultConfig, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  }),
}));
