import { Platform } from 'react-native';
import type { AuthUser } from '@/lib/authClient';
import { isDictationAgentEnabled, isNoteChatEnabled } from '@/lib/dictationAgent';
import type { InferenceSelection } from '@/lib/mobileProviders';
import { localModeDefault, MODE_LABELS, type CloudAccess } from '@/lib/inferenceModes';
import { isLocalModelKey, LOCAL_MODEL_TITLES } from '@/lib/localModelCatalog';
import { providerDisplayName, type MobileInferenceScope } from '@/lib/mobileProviders';
import type { InferenceMode, ProcessingMode, UserConfig } from '@/types';

export const WORKFLOW_LABELS: Record<MobileInferenceScope, string> = {
  dictation: 'Dictation',
  upload: 'Uploads',
  cleanup: 'Text Cleanup',
  notes: 'Note Formatting & Titles',
  noteChat: 'Note Chat',
  agent: 'Voice Assistant',
};

export const WORKFLOWS = Object.keys(WORKFLOW_LABELS) as MobileInferenceScope[];

// Bring Your Own Key dictation skips these workflows until a selection is saved for them.
export const UNSET_PROVIDER_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  cleanup: 'Not saved yet. Cleanup is skipped until you save a selection.',
  agent: 'Not saved yet. The voice assistant is skipped until you save a selection.',
};

// On-Device cleanup on an iPhone that can never run Apple Intelligence.
export const ON_DEVICE_CLEANUP_UNSUPPORTED_NOTE =
  Platform.OS === 'android'
    ? 'On-device cleanup is unavailable. Your raw transcript stays on this phone.'
    : "This iPhone can't run On-Device cleanup, so it's skipped. OpenWhispr Cloud can clean up your transcripts.";

// Dictation owns Local Mode: On-Device dictation turns it on, and the other modes turn it off.
const deviceLabel = Platform.OS === 'android' ? 'phone' : 'iPhone';
export const LOCAL_MODE_DICTATION_NOTES = {
  on:
    Platform.OS === 'android'
      ? 'Local Mode keeps dictation on this phone. Turn it off in Models & processing to use Cloud, or choose Bring Your Own Key.'
      : `Local Mode is on: dictation stays on this ${deviceLabel}, notes you make stay private, and note chat asks before leaving it. Choose OpenWhispr Cloud or Bring Your Own Key to turn it off.`,
  off:
    Platform.OS === 'android'
      ? 'On-Device turns on Local Mode: dictation stays on this phone and notes ask before leaving it.'
      : 'On-Device turns on Local Mode: dictation stays on this iPhone, notes you make stay private, and note chat asks before leaving it.',
};

// What Local Mode means for note chat.
export const ON_DEVICE_MODE_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  ...(Platform.OS === 'android'
    ? {
        upload: 'Local Mode keeps uploads on this phone.',
        notes:
          'Local Mode formats notes on this phone and asks before sending one to your choice here.',
        agent: 'In Local Mode the voice assistant is off.',
        cleanup:
          'In Local Mode, cleanup runs on this phone, or sends only the transcript text to your provider with Bring Your Own Key. OpenWhispr Cloud cleanup is skipped until Local Mode is off.',
      }
    : {}),
  noteChat: `In Local Mode note chat asks before sending a note off this ${deviceLabel}.`,
};

export const PRIVATE_MODE_LOCKED_REASON =
  Platform.OS === 'android'
    ? 'Off while Local Mode is on. Turn it off in Models & processing.'
    : 'Off while Local Mode is on. Change Dictation in AI Models to turn it off.';

// Android's explicit Local Mode switch continues to protect uploads and cleanup.
export const ANDROID_LOCAL_MODE_LOCKED: Partial<Record<MobileInferenceScope, InferenceMode[]>> = {
  dictation: ['openwhispr'],
  upload: ['openwhispr', 'providers'],
  cleanup: ['openwhispr'],
};

export function cleanupSavedOnDevice(config: UserConfig | null): boolean {
  return config?.inference?.cleanup?.mode === 'local';
}

// Outside Cloud dictation, cleaning with OpenWhispr Cloud is a separate Cloud pass, which needs a
// signed-in account.
export const CLOUD_CLEANUP_NEEDS_ACCOUNT_NOTE = `OpenWhispr Cloud cleans transcripts made on this ${deviceLabel} or with your own key only for a signed-in account, so cleanup is skipped until you sign in.`;

export function cloudAccessFor(user: AuthUser | null): CloudAccess {
  if (!user) return 'none';
  return user.isAnonymous ? 'session' : 'account';
}

// OpenWhispr Cloud runs for cleanup in Local Mode or Bring Your Own Key without an account to run
// it, so it is skipped (cleanupTranscript). In Local Mode that is a Cloud cleanup the user saved;
// unset or held there automatically, it runs on this iPhone without an account (workflowSelection).
export function cloudCleanupNeedsAccount(
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): boolean {
  return (
    Platform.OS !== 'android' &&
    activeMode !== 'cloud' &&
    cloudAccess !== 'account' &&
    workflowSelection(config, 'cleanup', activeMode, cloudAccess).mode === 'openwhispr'
  );
}

// Cleanup runs On-Device when it is saved as On-Device, or in Local Mode when it is unset or held on
// Cloud automatically and OpenWhispr Cloud can't clean (workflowSelection).
export function cleanupRunsOnDevice(
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): boolean {
  if (Platform.OS === 'android') return cleanupSavedOnDevice(config);
  return workflowSelection(config, 'cleanup', activeMode, cloudAccess).mode === 'local';
}

// What a workflow runs: its saved selection, else the mode's default (unsetSelection). In Local
// Mode, a Cloud selection held automatically (pinnedInference) when dictation left another mode runs
// as if unsaved, since Local Mode's default already uses Cloud wherever the user's access lets it:
// without a session uploads stay on this iPhone, and without an account so does cleanup. Leaving
// Local Mode finds it on Cloud again.
export function workflowSelection(
  config: UserConfig | null,
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess = 'none',
): InferenceSelection {
  const saved = config?.inference?.[scope];
  const heldOnCloudInLocalMode =
    Platform.OS !== 'android' &&
    activeMode === 'private' &&
    saved?.mode === 'openwhispr' &&
    !!config?.pinnedInference?.includes(scope);
  return saved && !heldOnCloudInLocalMode ? saved : unsetSelection(scope, activeMode, cloudAccess);
}

// Text Cleanup, Note Chat and the Voice Assistant have switches of their own; switched off, they
// run nothing and use no key.
export function workflowSwitchedOff(
  config: UserConfig | null,
  scope: MobileInferenceScope,
): boolean {
  if (!config) return false;
  if (scope === 'cleanup') return !(config.cleanupEnabled ?? true);
  if (scope === 'noteChat') return !isNoteChatEnabled(config);
  if (scope === 'agent') return !isDictationAgentEnabled(config);
  return false;
}

// The voice assistant runs on its own selection in every mode. It can run on a provider, or on
// OpenWhispr Cloud for a signed-in account, which an anonymous session can't use for it; it has no
// on-device version, and unset under Bring Your Own Key it is skipped.
export function voiceAssistantCanRun(
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): boolean {
  if (!config || workflowSwitchedOff(config, 'agent')) return false;
  if (Platform.OS === 'android' && activeMode === 'private') return false;
  const selection = workflowSelection(config, 'agent', activeMode, cloudAccess);
  if (selection.mode === 'providers') return !!selection.providerId;
  return selection.mode === 'openwhispr' && cloudAccess === 'account';
}

export function parseWorkflow(value: unknown): MobileInferenceScope | null {
  return WORKFLOWS.find((scope) => scope === value) ?? null;
}

// What a workflow with no saved selection runs. Local Mode keeps dictation on this iPhone, and uses
// OpenWhispr Cloud for uploads and cleanup when the account can, else this iPhone. Note formatting,
// note chat and the voice assistant use OpenWhispr Cloud when unset in Cloud and Local Mode, and
// Bring Your Own Key dictation waits for a provider before cleanup or the voice assistant.
export function unsetSelection(
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess = 'none',
): InferenceSelection {
  if (activeMode === 'private') return { mode: localModeDefault(scope, cloudAccess) };
  if (activeMode === 'providers' && (scope === 'dictation' || UNSET_PROVIDER_NOTES[scope]))
    return { mode: 'providers' };
  return { mode: 'openwhispr' };
}

export function workflowSummary(
  config: UserConfig | null,
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
  {
    keyMissing = false,
    onDeviceUnavailable,
    cloudAccess = 'none',
  }: {
    keyMissing?: boolean;
    // Why Apple Intelligence can't run right now, when it can't.
    onDeviceUnavailable?: string;
    cloudAccess?: CloudAccess;
  } = {},
): string {
  if (workflowSwitchedOff(config, scope)) return 'Off';
  if (Platform.OS === 'android' && activeMode === 'private' && scope === 'agent') return 'Off';
  if (scope === 'cleanup') {
    if (cleanupRunsOnDevice(config, activeMode, cloudAccess) && onDeviceUnavailable)
      return `Skipped · ${onDeviceUnavailable}`;
    if (cloudCleanupNeedsAccount(config, activeMode, cloudAccess)) return 'Skipped · Sign in';
  }
  const selection = workflowSelection(config, scope, activeMode, cloudAccess);
  if (Platform.OS === 'android' && activeMode === 'private') {
    if (
      scope === 'cleanup' &&
      !['local', 'providers'].includes(config?.inference?.cleanup?.mode ?? '')
    )
      return 'Skipped';
    if (scope === 'upload' || scope === 'notes') return MODE_LABELS.local;
  }
  // Local Mode runs dictation and provider note chat on this phone first, whatever is saved; note
  // chat set to OpenWhispr, or not set, goes straight to Cloud. The other workflows run what is
  // saved for them.
  if (activeMode === 'private' && scope === 'noteChat' && selection.mode === 'openwhispr')
    return MODE_LABELS.openwhispr;
  if (selection.mode === 'local' && isLocalModelKey(selection.modelId))
    return LOCAL_MODEL_TITLES[selection.modelId];
  if (activeMode === 'private' && (scope === 'dictation' || scope === 'noteChat'))
    return MODE_LABELS.local;
  if (selection.mode !== 'providers') return MODE_LABELS[selection.mode];
  if (!selection.providerId) return 'Not set';
  const name = providerDisplayName(selection.providerId);
  return keyMissing ? `${name} · Key missing` : name;
}
