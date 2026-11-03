import { create, type StoreApi } from 'zustand';
import type { UserConfig } from '../types';
import { StorageService } from '../services/storage/StorageService';
import {
  localModeUpgradeConfig,
  noteChatSplitConfig,
  notesLocalModeSplitConfig,
} from '../lib/inferenceModes';
import { withoutRetiredModels } from '../lib/retiredModels';
import { useProcessingModeStore } from './useProcessingModeStore';

export interface ConfigState {
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

export interface ConfigOperation {
  enqueue: (operation: () => Promise<void>) => Promise<void>;
  configForSave: (config: UserConfig) => UserConfig;
  didPersist?: (config: UserConfig) => void;
  success: (config: UserConfig) => Partial<ConfigState>;
  failure: (error: unknown) => Partial<ConfigState>;
  finish: () => void;
}
export interface ConfigStoreLifecycle {
  load: () => ConfigOperation;
  update: (updates: Partial<UserConfig>) => ConfigOperation;
  reset: () => ConfigOperation;
}
export interface ConfigStoreContext {
  set: StoreApi<ConfigState>['setState'];
  get: StoreApi<ConfigState>['getState'];
  defaultConfig: UserConfig;
}

export function createConfigStore(
  createLifecycle?: (context: ConfigStoreContext) => ConfigStoreLifecycle,
) {
  return create<ConfigState>((set, get) => {
    const lifecycle = createLifecycle?.({ set, get, defaultConfig });
    const load = async (operation?: ConfigOperation) => {
      if (!operation) set({ isLoading: true, error: null });
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
          await StorageService.saveConfig(
            operation ? operation.configForSave(resolvedConfig) : resolvedConfig,
          ).catch(() => undefined);
        }
        useProcessingModeStore.getState().resetToDefault(resolvedConfig.defaultMode);
        set(
          operation
            ? operation.success(resolvedConfig)
            : { config: resolvedConfig, isLoading: false },
        );
      } catch (error) {
        set(
          operation
            ? operation.failure(error)
            : { error: (error as Error).message, isLoading: false, config: defaultConfig },
        );
        useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
      } finally {
        operation?.finish();
      }
    };
    const update = async (resolveConfig: () => UserConfig, operation?: ConfigOperation) => {
      const newConfig = resolveConfig();
      if (!operation) set({ isLoading: true, error: null });
      try {
        await StorageService.saveConfig(newConfig);
        operation?.didPersist?.(newConfig);
        const modeStore = useProcessingModeStore.getState();
        if (!modeStore.isUserOverride) modeStore.resetToDefault(newConfig.defaultMode);
        set(operation ? operation.success(newConfig) : { config: newConfig, isLoading: false });
      } catch (error) {
        set(
          operation
            ? operation.failure(error)
            : { error: (error as Error).message, isLoading: false },
        );
      } finally {
        operation?.finish();
      }
    };
    const reset = async (operation?: ConfigOperation) => {
      if (!operation) set({ isLoading: true, error: null });
      try {
        await StorageService.clearConfig();
        operation?.didPersist?.(defaultConfig);
        useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
        set(
          operation
            ? operation.success(defaultConfig)
            : { config: defaultConfig, isLoading: false },
        );
      } catch (error) {
        set(
          operation
            ? operation.failure(error)
            : { error: (error as Error).message, isLoading: false },
        );
      } finally {
        operation?.finish();
      }
    };
    return {
      config: null,
      isLoading: false,
      error: null,
      loadConfig: () => {
        const operation = lifecycle?.load();
        return operation ? operation.enqueue(() => load(operation)) : load();
      },
      updateConfig: (updates) => {
        const operation = lifecycle?.update(updates);
        const nextConfig = () => ({ ...(get().config || defaultConfig), ...updates });
        return operation
          ? operation.enqueue(() => update(() => operation.configForSave(nextConfig()), operation))
          : update(nextConfig);
      },
      resetConfig: () => {
        const operation = lifecycle?.reset();
        return operation ? operation.enqueue(() => reset(operation)) : reset();
      },
    };
  });
}
