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
    .filter((mode) => mode !== 'providers' || Platform.OS === 'ios' || Platform.OS === 'android')
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

// What Local Mode runs for a workflow with nothing saved: this iPhone for dictation; OpenWhispr
// Cloud for note formatting, note chat and the voice assistant, as in Cloud mode, and for uploads
// and cleanup when the account can use it there; this iPhone otherwise.
export function localModeDefault(
  scope: MobileInferenceScope,
  cloudAccess: CloudAccess,
): InferenceMode {
  // Android Local Mode retains its strict audio/text boundary.
  if (Platform.OS === 'android') return scope === 'agent' ? 'openwhispr' : 'local';
  const onCloud =
    scope === 'notes' ||
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

// The workflows besides dictation, which a dictation change never moves.
const OTHER_WORKFLOWS = ['upload', 'cleanup', 'notes', 'noteChat', 'agent'] as const;
type OtherWorkflow = (typeof OTHER_WORKFLOWS)[number];

// The on-device model picked for a workflow, else Automatic.
export function localSelection(
  config: Pick<UserConfig, 'rememberedInference'> | null,
  scope: MobileInferenceScope,
): InferenceSelection {
  return config?.rememberedInference?.[scope]?.local ?? { mode: 'local' };
}

// What a workflow with nothing saved runs in `mode`, or undefined when there is nothing to hold:
// cleanup and the voice assistant are skipped under Bring Your Own Key until a provider is saved
// for them. Local Mode asks before note chat leaves the phone, which no other mode does, so note
// chat is held On-Device rather than sent to Cloud unasked.
function unsavedRunsIn(
  config: Pick<UserConfig, 'rememberedInference'> | null,
  scope: OtherWorkflow,
  mode: ProcessingMode,
  cloudAccess: CloudAccess,
): InferenceSelection | undefined {
  if (mode === 'providers' && (scope === 'cleanup' || scope === 'agent')) return undefined;
  const onDevice =
    mode === 'private' &&
    (scope === 'noteChat' || localModeDefault(scope, cloudAccess) === 'local');
  return onDevice ? localSelection(config, scope) : { mode: 'openwhispr' };
}

// Onboarding's config for the dictation mode it picks. It releases the automatic pins, replaying the
// same choice included, since a Dictation change in AI Models may have held them in that mode, so
// those workflows follow the picked mode again; selections the user saved themselves stay.
export function dictationModeConfig(
  config: UserConfig | null,
  mode: 'cloud' | 'private',
): DictationModeConfig {
  const modeChanged = config?.defaultMode !== mode;
  const releasePins = Platform.OS !== 'android' || modeChanged;
  const pinned = releasePins ? (config?.pinnedInference ?? []) : [];
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
      dictation: mode === 'private' ? localSelection(config, 'dictation') : { mode: 'openwhispr' },
    },
    ...(releasePins && config?.pinnedInference ? { pinnedInference: undefined } : {}),
    ...(Platform.OS === 'android' && config?.privateModeReturn
      ? { privateModeReturn: undefined }
      : {}),
  };
}

// Changing the dictation mode changes only dictation: the automatic pins stay, and each workflow
// with nothing saved is saved as what it ran in the mode being left, as an automatic pin.
function dictationSwitchConfig(
  config: UserConfig | null,
  dictation: InferenceSelection,
  mode: ProcessingMode,
  leavingMode: ProcessingMode,
  cloudAccess: CloudAccess,
): DictationModeConfig {
  const inference = { ...config?.inference, dictation };
  if (mode === leavingMode) return { defaultMode: mode, inference };
  const pinnedInference = [...(config?.pinnedInference ?? [])];
  for (const scope of OTHER_WORKFLOWS) {
    if (inference[scope]) continue;
    const selection = unsavedRunsIn(config, scope, leavingMode, cloudAccess);
    if (!selection) continue;
    inference[scope] = selection;
    if (!pinnedInference.includes(scope)) pinnedInference.push(scope);
  }
  return {
    defaultMode: mode,
    inference,
    ...(pinnedInference.length ? { pinnedInference } : {}),
  };
}

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

// The config a workflow page writes when the user saves `selection` for `scope`. `cloudAccess` is
// what the user has on OpenWhispr Cloud, which decides what an unsaved workflow ran in Local Mode.
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
    if (Platform.OS === 'android') {
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
    // On-Device restores the model picked on the Dictation page.
    const dictation =
      mode === 'providers'
        ? selection
        : mode === 'private'
          ? localSelection(config, 'dictation')
          : { mode: 'openwhispr' as const };
    return {
      ...rememberedInference,
      ...dictationSwitchConfig(config, dictation, mode, activeMode, cloudAccess),
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
// They are automatic pins, which a dictation change keeps and only onboarding releases, and a
// pinned cleanup Apple Intelligence can't run yet is skipped quietly (skipsLocalModeCleanup).
export function holdOnDeviceConfig(
  config: Pick<UserConfig, 'inference' | 'pinnedInference' | 'rememberedInference'>,
): Pick<UserConfig, 'inference' | 'pinnedInference'> {
  const inference = { ...config.inference };
  const pinnedInference = [...(config.pinnedInference ?? [])];
  for (const scope of ['upload', 'cleanup'] as const) {
    const saved = inference[scope];
    if (saved && saved.mode !== 'openwhispr') continue;
    inference[scope] = localSelection(config, scope);
    if (!pinnedInference.includes(scope)) pinnedInference.push(scope);
  }
  return { inference, pinnedInference };
}

// Before Local Mode used OpenWhispr Cloud for uploads and cleanup with nothing saved, it kept both
// on this iPhone and ignored a Cloud choice saved for them, so a config from then that is in Local
// Mode keeps them there: the upgrade sends nothing to Cloud that was never sent before.
export function localModeUpgradeConfig(config: UserConfig): Partial<UserConfig> {
  if (Platform.OS === 'android' || config.defaultMode !== 'private')
    return { localModeUpgraded: true };
  return { localModeUpgraded: true, ...holdOnDeviceConfig(config) };
}

// Note chat once used the voice assistant's selection (agent), so a config from then gives it the
// same selection, remembered providers and hold, leaving anything saved for note chat alone.
export function noteChatSplitConfig(config: UserConfig): Partial<UserConfig> {
  const agent = config.inference?.agent;
  const copied = !!agent && !config.inference?.noteChat;
  const rememberedAgent = config.rememberedInference?.agent;
  const returnPins = config.privateModeReturn?.pinned;
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
    // Android may upgrade while Local Mode is temporarily holding a provider configuration.
    ...(returnPins?.agent && !returnPins.noteChat
      ? { privateModeReturn: { pinned: { ...returnPins, noteChat: returnPins.agent } } }
      : {}),
  };
}

// Local Mode once formatted notes on this iPhone whatever was saved for them. A config from then
// that is in Local Mode, with nothing of the user's own saved for note formatting, holds it
// On-Device, so the update sends no note to Cloud that wasn't sent before.
export function notesLocalModeSplitConfig(config: UserConfig): Partial<UserConfig> {
  if (Platform.OS === 'android') return { notesLocalModeSplit: true };
  const saved = config.inference?.notes;
  const ownChoice = !!saved && !config.pinnedInference?.includes('notes');
  if (config.defaultMode !== 'private' || ownChoice) return { notesLocalModeSplit: true };
  return {
    notesLocalModeSplit: true,
    inference: { ...config.inference, notes: localSelection(config, 'notes') },
    pinnedInference: saved
      ? (config.pinnedInference ?? [])
      : [...(config.pinnedInference ?? []), 'notes'],
  };
}
