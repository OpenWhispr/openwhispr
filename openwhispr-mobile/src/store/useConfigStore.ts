import { create } from 'zustand';
import { UserConfig } from '../types';
import { StorageService } from '../services/storage/StorageService';
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
};

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  loadConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      const config = await StorageService.getConfig();
      const resolvedConfig = config || defaultConfig;
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

  updateConfig: async (updates: Partial<UserConfig>) => {
    const currentConfig = get().config || defaultConfig;
    const newConfig = { ...currentConfig, ...updates };

    set({ isLoading: true, error: null });
    try {
      await StorageService.saveConfig(newConfig);
      const modeStore = useProcessingModeStore.getState();
      if (!modeStore.isUserOverride) {
        modeStore.resetToDefault(newConfig.defaultMode);
      }
      set({ config: newConfig, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
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
