import { Platform } from 'react-native';
import type { LucideIconName } from '@/components/ui/SystemIcon';
import type { InferenceSelection, MobileInferenceScope } from '@/lib/mobileProviders';
import {
  inferenceToProcessingMode,
  processingToInferenceMode,
  type InferenceMode,
  type ProcessingMode,
  type UserConfig,
} from '@/types';

export type ModeDescriptor = {
  mode: InferenceMode;
  icon: string;
  mdIcon: LucideIconName;
  title: string;
  description: string;
};

export type InferenceScope = 'speech' | 'text';

const BASE: Record<InferenceMode, Omit<ModeDescriptor, 'description'>> = {
  providers: { mode: 'providers', icon: 'key', mdIcon: 'KeyRound', title: 'Bring Your Own Key' },
  openwhispr: {
    mode: 'openwhispr',
    icon: 'cloud',
    mdIcon: 'Cloud',
    title: 'OpenWhispr Cloud',
  },
  local: {
    mode: 'local',
    icon: 'iphone',
    mdIcon: 'Smartphone',
    title: 'On-Device',
  },
};

const DESCRIPTIONS: Record<InferenceScope, Record<InferenceMode, string>> = {
  speech: {
    providers: 'Use your own provider key. Billed by your provider.',
    openwhispr: 'Hosted by OpenWhispr. Requires sign-in.',
    local: 'Audio never leaves this phone.',
  },
  text: {
    providers: 'Use your own provider key. Billed by your provider.',
    openwhispr: 'Hosted by OpenWhispr. Requires sign-in.',
    local: 'Text never leaves this phone.',
  },
};

export function getInferenceModes(scope: InferenceScope): ModeDescriptor[] {
  return (['openwhispr', 'local', 'providers'] as const)
    .filter((mode) => mode !== 'providers' || Platform.OS === 'ios')
    .map((mode) => ({ ...BASE[mode], description: DESCRIPTIONS[scope][mode] }));
}

export const MODE_LABELS: Record<InferenceMode, string> = {
  providers: 'Bring Your Own Key',
  openwhispr: 'OpenWhispr Cloud',
  local: 'On-Device',
};

type DictationModeConfig = Pick<
  UserConfig,
  'defaultMode' | 'inference' | 'pinnedInference' | 'privateModeReturn'
>;

// These workflows follow the dictation mode until they have a selection of their own, so they
// would silently change destination when dictation moves to Bring Your Own Key. Cleanup is left
// out: unsaved, it is skipped in that mode, which sends nothing anywhere. The voice assistant is
// pinned only when leaving On-Device; unsaved, it is skipped rather than sent to Cloud.
function scopesToPin(leavingMode: ProcessingMode): MobileInferenceScope[] {
  return leavingMode === 'private' ? ['upload', 'notes', 'agent'] : ['upload', 'notes'];
}

// The Private Mode switch and the Dictation page both own the dictation mode;
// writing the scope selection alongside defaultMode keeps routing and UI in step.
export function dictationModeConfig(
  config: UserConfig | null,
  mode: 'cloud' | 'private',
): DictationModeConfig {
  // Leaving Bring Your Own Key releases the automatic pins, so those workflows follow the
  // Cloud/On-Device choice again; selections the user saved themselves stay.
  const pinned = config?.pinnedInference ?? [];
  const inference = Object.fromEntries(
    Object.entries(config?.inference ?? {}).filter(
      ([scope]) => !pinned.includes(scope as MobileInferenceScope),
    ),
  );
  return {
    defaultMode: mode,
    inference: {
      ...inference,
      // On-Device restores the model picked on the Dictation page.
      dictation:
        mode === 'private'
          ? (config?.rememberedInference?.dictation?.local ?? { mode: 'local' })
          : { mode: 'openwhispr' },
    },
    ...(config?.pinnedInference ? { pinnedInference: undefined } : {}),
    // Only a switch from Bring Your Own Key sets where Private mode returns to (workflowSaveConfig).
    ...(config?.privateModeReturn ? { privateModeReturn: undefined } : {}),
  };
}

function providerDictationConfig(
  config: UserConfig | null,
  dictation: InferenceSelection,
  leavingMode: ProcessingMode,
): DictationModeConfig {
  const inference = { ...config?.inference, dictation };
  const pinnedInference = [...(config?.pinnedInference ?? [])];
  // Leaving Private mode for the provider it was turned on from holds what that provider held,
  // so the round trip ends where it started.
  const pins: [MobileInferenceScope, InferenceSelection][] =
    leavingMode === 'providers'
      ? []
      : leavingMode === 'private' && config?.privateModeReturn
        ? (Object.entries(config.privateModeReturn.pinned) as [
            MobileInferenceScope,
            InferenceSelection,
          ][])
        : scopesToPin(leavingMode).map((scope) => [
            scope,
            { mode: processingToInferenceMode(leavingMode) },
          ]);
  for (const [scope, selection] of pins) {
    if (inference[scope]) continue;
    inference[scope] = selection;
    pinnedInference.push(scope);
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

// The config a workflow page writes when the user saves `selection` for `scope`.
export function workflowSaveConfig(
  config: UserConfig | null,
  scope: MobileInferenceScope,
  selection: InferenceSelection,
  activeMode: ProcessingMode,
): Partial<UserConfig> {
  const { providerId } = selection;
  const otherProviders = Object.fromEntries(
    Object.entries(config?.rememberedInference?.[scope] ?? {}).filter(([id]) => id !== providerId),
  );
  // Most recent first, so switching back to Bring Your Own Key restores the last provider used.
  const rememberedInference = providerId
    ? {
        rememberedInference: {
          ...config?.rememberedInference,
          [scope]: { [providerId]: selection, ...otherProviders },
        },
      }
    : {};
  if (scope === 'dictation') {
    const mode = inferenceToProcessingMode(selection.mode);
    // Picking another on-device model keeps where Private mode returns to; leaving it clears it.
    const privateModeReturn =
      mode !== 'private'
        ? undefined
        : activeMode === 'private'
          ? config?.privateModeReturn
          : activeMode === 'providers'
            ? { pinned: pinnedSelections(config) }
            : undefined;
    return {
      ...rememberedInference,
      ...(mode === 'providers'
        ? providerDictationConfig(config, selection, activeMode)
        : dictationModeConfig(config, mode)),
      ...(privateModeReturn || config?.privateModeReturn ? { privateModeReturn } : {}),
    };
  }
  return {
    ...rememberedInference,
    inference: { ...config?.inference, [scope]: selection },
    ...(config?.pinnedInference
      ? { pinnedInference: config.pinnedInference.filter((pinned) => pinned !== scope) }
      : {}),
  };
}
