import { Platform } from 'react-native';
import type { LucideIconName } from '@/components/ui/SystemIcon';
import type { InferenceSelection, MobileInferenceScope } from '@/lib/mobileProviders';
import { isDictationAgentEnabled } from '@/lib/dictationAgent';
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

// What a user can do on OpenWhispr Cloud, by the rules in accountAccess: any session transcribes
// there, but a separate Cloud pass over text, such as cleaning a transcript made on this iPhone,
// needs a signed-in account.
export type CloudAccess = 'none' | 'session' | 'account';

// What Local Mode runs for a workflow with nothing saved: OpenWhispr Cloud for note chat, and for
// uploads and cleanup when the account can use it there; this iPhone otherwise.
export function localModeDefault(
  scope: MobileInferenceScope,
  cloudAccess: CloudAccess,
): InferenceMode {
  const onCloud =
    scope === 'agent' ||
    scope === 'noteChat' ||
    (scope === 'upload' && cloudAccess !== 'none') ||
    (scope === 'cleanup' && cloudAccess === 'account');
  return onCloud ? 'openwhispr' : 'local';
}

type DictationModeConfig = Pick<
  UserConfig,
  'defaultMode' | 'inference' | 'pinnedInference' | 'privateModeReturn'
>;

// These workflows follow the dictation mode until they have a selection of their own, so they
// would silently change destination when dictation moves to Bring Your Own Key. Cleanup is left
// out: unsaved, it is skipped in that mode, which sends nothing anywhere. The voice assistant and
// note chat are pinned only when leaving On-Device; unsaved, the voice assistant is skipped rather
// than sent to Cloud, and note chat stays where it was before it had a setting of its own.
function scopesToPin(leavingMode: ProcessingMode): MobileInferenceScope[] {
  return leavingMode === 'private' ? ['upload', 'notes', 'agent', 'noteChat'] : ['upload', 'notes'];
}

// The Dictation page and onboarding own the dictation mode;
// writing the scope selection alongside defaultMode keeps routing and UI in step.
export function dictationModeConfig(
  config: UserConfig | null,
  mode: 'cloud' | 'private',
): DictationModeConfig {
  // Changing the mode releases the automatic pins, so those workflows follow the Cloud/On-Device
  // choice again; selections the user saved themselves stay. Picking another on-device model, or
  // replaying the same choice in onboarding, keeps them.
  const modeChanged = config?.defaultMode !== mode;
  const pinned = modeChanged ? (config?.pinnedInference ?? []) : [];
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
    ...(modeChanged && config?.pinnedInference ? { pinnedInference: undefined } : {}),
    // Only a switch from Bring Your Own Key sets where Private mode returns to (workflowSaveConfig).
    ...(config?.privateModeReturn ? { privateModeReturn: undefined } : {}),
  };
}

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
        : scopesToPin(leavingMode).map((scope) => [
            scope,
            {
              // Each holds what ran in the mode being left: uploads in Local Mode ran on
              // OpenWhispr Cloud when there was a session. Unset note chat ran on Cloud after
              // asking; Bring Your Own Key would send it there without asking, so it is held
              // On-Device, as it was before it had a setting of its own.
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

// The config a workflow page writes when the user saves `selection` for `scope`. `cloudAccess` is
// what the user has on OpenWhispr Cloud, which decides what ran for uploads in Local Mode.
export function workflowSaveConfig(
  config: UserConfig | null,
  scope: MobileInferenceScope,
  selection: InferenceSelection,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess = 'none',
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
        ? providerDictationConfig(config, selection, activeMode, cloudAccess)
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

// Holds uploads and cleanup on this iPhone unless the user saved On-Device or a provider for them.
// They are automatic pins, so changing the mode releases them to its defaults, and a pinned
// cleanup Apple Intelligence can't run yet is skipped quietly (skipsLocalModeCleanup).
export function holdOnDeviceConfig(
  config: Pick<UserConfig, 'inference' | 'pinnedInference' | 'rememberedInference'>,
): Pick<UserConfig, 'inference' | 'pinnedInference'> {
  const inference = { ...config.inference };
  const pinnedInference = [...(config.pinnedInference ?? [])];
  for (const scope of ['upload', 'cleanup'] as const) {
    const saved = inference[scope];
    if (saved && saved.mode !== 'openwhispr') continue;
    inference[scope] = config.rememberedInference?.[scope]?.local ?? { mode: 'local' };
    if (!pinnedInference.includes(scope)) pinnedInference.push(scope);
  }
  return { inference, pinnedInference };
}

// Before Local Mode used OpenWhispr Cloud for uploads and cleanup with nothing saved, it kept both
// on this iPhone and ignored a Cloud choice saved for them, so a config from then that is in Local
// Mode keeps them there: the upgrade sends nothing to Cloud that was never sent before.
export function localModeUpgradeConfig(config: UserConfig): Partial<UserConfig> {
  if (config.defaultMode !== 'private') return { localModeUpgraded: true };
  return { localModeUpgraded: true, ...holdOnDeviceConfig(config) };
}

// Note chat once used the voice assistant's selection (agent), so a config from then gives it the
// same selection, remembered providers and hold, leaving anything saved for note chat alone.
export function noteChatSplitConfig(config: UserConfig): Partial<UserConfig> {
  const agent = config.inference?.agent;
  const copied = !!agent && !config.inference?.noteChat;
  const rememberedAgent = config.rememberedInference?.agent;
  const heldAgent = config.privateModeReturn?.pinned.agent;
  return {
    noteChatSplit: true,
    // Note chat's switch followed the voice assistant's until set; saving it keeps it put.
    ...(config.noteChatEnabled === undefined
      ? { noteChatEnabled: isDictationAgentEnabled(config) }
      : {}),
    ...(copied ? { inference: { ...config.inference, noteChat: agent } } : {}),
    ...(rememberedAgent && !config.rememberedInference?.noteChat
      ? { rememberedInference: { ...config.rememberedInference, noteChat: rememberedAgent } }
      : {}),
    ...(copied && config.pinnedInference?.includes('agent')
      ? { pinnedInference: [...config.pinnedInference, 'noteChat'] }
      : {}),
    ...(heldAgent && !config.privateModeReturn?.pinned.noteChat
      ? {
          privateModeReturn: {
            pinned: { ...config.privateModeReturn?.pinned, noteChat: heldAgent },
          },
        }
      : {}),
  };
}
