import { create, type StoreApi } from 'zustand';
import type { UserConfig } from '@/android/types';
import { StorageService } from '@/android/shared/services/storage/StorageService';
import {
  localModeUpgradeConfig,
  noteChatSplitConfig,
  notesLocalModeSplitConfig,
} from '@/lib/inferenceModes';
import { withoutRetiredModels } from '@/android/shared/lib/retiredModels';
import { useProcessingModeStore } from '@/android/shared/store/useProcessingModeStore';
import { dlog } from '@/android/lib/debugLog';

/** Where a config change came from, for the debug log. */
export type ConfigChangeSource = 'user' | 'policy' | 'retired_move' | 'default' | 'migration';

/**
 * Logs the settings a debug log needs to explain a run: each task's engine, the default mode,
 * cleanup, the phone's models, the translation target and the languages. Ids and codes only;
 * a custom server's address and a key's reference are never written.
 */
function logConfigChanges(
  previous: UserConfig | null,
  next: UserConfig,
  source: ConfigChangeSource | 'unknown',
): void {
  try {
    const scopes = new Set([
      ...Object.keys(previous?.inference ?? {}),
      ...Object.keys(next.inference ?? {}),
    ]) as Set<keyof NonNullable<UserConfig['inference']>>;
    for (const scope of scopes) {
      const before = previous?.inference?.[scope];
      const after = next.inference?.[scope];
      if (
        before?.mode === after?.mode &&
        before?.providerId === after?.providerId &&
        before?.modelId === after?.modelId &&
        !!before?.endpoint === !!after?.endpoint
      )
        continue;
      dlog.info('set', 'scope', {
        scope,
        old_mode: before?.mode,
        old_provider: before?.providerId,
        old_model: before?.modelId,
        new_mode: after?.mode,
        new_provider: after?.providerId,
        new_model: after?.modelId,
        custom_endpoint: !!after?.endpoint,
        source,
      });
    }
    if (previous?.defaultMode !== next.defaultMode)
      dlog.info('set', 'default_mode', {
        from: previous?.defaultMode,
        to: next.defaultMode,
        source,
      });
    if (previous?.cleanupEnabled !== next.cleanupEnabled)
      dlog.info('set', 'cleanup', { enabled: next.cleanupEnabled ?? null, source });
    if (previous?.androidSpeechModel !== next.androidSpeechModel)
      dlog.info('set', 'speech_model', {
        from: previous?.androidSpeechModel,
        to: next.androidSpeechModel,
        source,
      });
    if (previous?.androidTextModel !== next.androidTextModel)
      dlog.info('set', 'text_model', {
        from: previous?.androidTextModel,
        to: next.androidTextModel,
        source,
      });
    if (previous?.androidTranslationTarget?.code !== next.androidTranslationTarget?.code)
      dlog.info('set', 'translation_target', {
        from: previous?.androidTranslationTarget?.code,
        to: next.androidTranslationTarget?.code,
        source,
      });
    const languagesBefore = (previous?.languages ?? []).join(',');
    const languagesAfter = (next.languages ?? []).join(',');
    if (
      languagesBefore !== languagesAfter ||
      previous?.preferredLanguage !== next.preferredLanguage
    )
      dlog.info('set', 'languages', {
        lang: languagesAfter || undefined,
        count: next.languages?.length ?? 0,
        from: previous?.preferredLanguage,
        to: next.preferredLanguage,
        source,
      });
    // Tone & Style (style/toneStyle.ts) lives in the same blob; read raw so this file needn't
    // import it (it imports the store). Category and tone names only.
    type StoredTone = { enabled?: boolean; tones?: Record<string, string> } | undefined;
    const toneBefore = (previous as { androidToneStyle?: StoredTone } | null)?.androidToneStyle;
    const toneAfter = (next as { androidToneStyle?: StoredTone }).androidToneStyle;
    if ((toneBefore?.enabled === true) !== (toneAfter?.enabled === true))
      dlog.info('style', 'enabled', { enabled: toneAfter?.enabled === true, source });
    for (const category of Object.keys(toneAfter?.tones ?? {}))
      if (toneBefore?.tones?.[category] !== toneAfter?.tones?.[category])
        dlog.info('style', 'tone', {
          category,
          tone: toneAfter?.tones?.[category],
          from: toneBefore?.tones?.[category],
          source,
        });
  } catch {
    /* The log must never break a settings change. */
  }
}

export interface ConfigState {
  config: UserConfig | null;
  isLoading: boolean;
  error: string | null;
  loadConfig: () => Promise<void>;
  /** `source` only labels the debug log line; a change with none reads as the user's. */
  updateConfig: (config: Partial<UserConfig>, source?: ConfigChangeSource) => Promise<void>;
  resetConfig: () => Promise<void>;
}

const defaultConfig: UserConfig = {
  defaultMode: 'cloud',
  appleLocalIntelligenceEnabled: true,
  localModeUpgraded: true,
  noteChatSplit: true,
  notesLocalModeSplit: true,
};

let pendingConfigOperation: Promise<void> = Promise.resolve();

function serializeConfigOperation(operation: () => Promise<void>): Promise<void> {
  const result = pendingConfigOperation.then(operation);
  pendingConfigOperation = result.catch(() => undefined);
  return result;
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
      require('@/android/lib/productEvents') as typeof import('@/android/lib/productEvents');
    await prepareProductEventsOptIn();
  }
}

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
          logConfigChanges(config, resolvedConfig, 'migration');
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
            : {
                error: (error as Error).message,
                isLoading: false,
                config: { ...defaultConfig, usageAnalyticsEnabled: false },
              },
        );
        useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
      } finally {
        operation?.finish();
      }
    };
    const update = async (
      resolveConfig: () => UserConfig,
      operation?: ConfigOperation,
      source: ConfigChangeSource = 'user',
    ) => {
      const currentConfig = get().config;
      const newConfig = resolveConfig();
      if (!operation) set({ isLoading: true, error: null });
      try {
        // The default (iOS) store fences product-event opt-in here; Android's lifecycle owns consent.
        if (!operation) await prepareConfigChange(currentConfig, newConfig);
        await StorageService.saveConfig(newConfig);
        logConfigChanges(currentConfig, newConfig, source);
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
        if (!operation) await prepareConfigChange(get().config, defaultConfig);
        await StorageService.clearConfig();
        logConfigChanges(get().config, defaultConfig, 'default');
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
        return operation
          ? operation.enqueue(() => load(operation))
          : serializeConfigOperation(() => load());
      },
      updateConfig: (updates, source) => {
        const operation = lifecycle?.update(updates);
        const nextConfig = () => ({ ...(get().config || defaultConfig), ...updates });
        return operation
          ? operation.enqueue(() =>
              update(() => operation.configForSave(nextConfig()), operation, source),
            )
          : serializeConfigOperation(() => update(nextConfig, undefined, source));
      },
      resetConfig: () => {
        const operation = lifecycle?.reset();
        return operation
          ? operation.enqueue(() => reset(operation))
          : serializeConfigOperation(() => reset());
      },
    };
  });
}
