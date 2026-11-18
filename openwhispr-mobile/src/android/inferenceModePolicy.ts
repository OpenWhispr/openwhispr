import type { InferenceSelection, MobileInferenceScope } from '@/lib/mobileProviders';
import { processingToInferenceMode, type ProcessingMode, type UserConfig } from '@/types';
import type {
  CloudAccess,
  DictationModeConfig,
  InferenceModeHelpers,
  InferenceModePolicy,
} from '../lib/inferenceModesCore';

export function createAndroidInferencePolicy({
  localModeDefault,
  dictationModeConfig,
}: InferenceModeHelpers): InferenceModePolicy {
  // Android's explicit Local Mode switch returns to its previous provider and pinned selections.
  function providerDictationConfig(
    config: UserConfig | null,
    dictation: InferenceSelection,
    leavingMode: ProcessingMode,
    cloudAccess: CloudAccess,
  ): DictationModeConfig {
    const inference = { ...config?.inference, dictation };
    const pinnedInference = [...(config?.pinnedInference ?? [])];
    // Leaving Private mode for the provider it was turned on from holds what that provider held,
    // so the round trip ends where it started, even over a workflow Local Mode held automatically.
    const returning = leavingMode === 'private' && !!config?.privateModeReturn;
    const pins: [MobileInferenceScope, InferenceSelection][] =
      leavingMode === 'providers'
        ? []
        : returning
          ? (Object.entries(config?.privateModeReturn?.pinned ?? {}) as [
              MobileInferenceScope,
              InferenceSelection,
            ][])
          : (leavingMode === 'private'
              ? (['upload', 'notes', 'noteChat', 'agent'] as const)
              : (['upload', 'notes'] as const)
            ).map((scope) => [
              scope,
              {
                // Preserve the prior mode; Android uploads stay local in Local Mode.
                mode:
                  leavingMode === 'private' && scope === 'upload'
                    ? localModeDefault(scope, cloudAccess)
                    : processingToInferenceMode(leavingMode),
              },
            ]);
    for (const [scope, selection] of pins) {
      const heldAutomatically = pinnedInference.includes(scope);
      if (inference[scope] && !(returning && heldAutomatically)) continue;
      inference[scope] = selection;
      if (!heldAutomatically) pinnedInference.push(scope);
    }
    return {
      defaultMode: 'providers',
      inference,
      ...(pinnedInference.length ? { pinnedInference } : {}),
    };
  }

  // What Bring Your Own Key holds on the mode dictation came from, kept while Private mode is on.
  function pinnedSelections(
    config: UserConfig | null,
  ): Partial<Record<MobileInferenceScope, InferenceSelection>> {
    return Object.fromEntries(
      (config?.pinnedInference ?? []).flatMap((scope) => {
        const selection = config?.inference?.[scope];
        return selection ? [[scope, selection]] : [];
      }),
    );
  }

  return {
    providersAvailable: () => true,
    localModeDefault: (scope) => (scope === 'agent' ? 'openwhispr' : 'local'),
    releaseDictationPins: (config, mode) => config?.defaultMode !== mode,
    dictationModeExtras: (config) =>
      config?.privateModeReturn ? { privateModeReturn: undefined } : {},
    saveDictation: (config, selection, mode, activeMode, cloudAccess) => {
      const privateModeReturn =
        mode !== 'private'
          ? undefined
          : activeMode === 'private'
            ? config?.privateModeReturn
            : activeMode === 'providers'
              ? { pinned: pinnedSelections(config) }
              : undefined;
      return {
        ...(mode === 'providers'
          ? providerDictationConfig(config, selection, activeMode, cloudAccess)
          : dictationModeConfig(config, mode)),
        ...(privateModeReturn || config?.privateModeReturn ? { privateModeReturn } : {}),
      };
    },
    localModeUpgradeConfig: () => ({ localModeUpgraded: true }),
    noteChatSplitConfig: (config, split) => {
      const returnPins = config.privateModeReturn?.pinned;
      return {
        ...split(),
        ...(returnPins?.agent && !returnPins.noteChat
          ? { privateModeReturn: { pinned: { ...returnPins, noteChat: returnPins.agent } } }
          : {}),
      };
    },
    notesLocalModeSplitConfig: () => ({ notesLocalModeSplit: true }),
  };
}
