import { Platform } from 'react-native';
import type { AuthUser } from '@/lib/authClient';
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
  agent: 'Chat & Voice Assistant',
};

export const WORKFLOWS = Object.keys(WORKFLOW_LABELS) as MobileInferenceScope[];

// Bring Your Own Key dictation skips these workflows until a selection is saved for them.
export const UNSET_PROVIDER_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  cleanup: 'Not saved yet. Cleanup is skipped until you save a selection.',
  agent:
    'Not saved yet. The voice assistant is skipped until you save a selection; note chat uses OpenWhispr Cloud.',
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
      : `Local Mode is on: dictation stays on this ${deviceLabel} and notes ask before leaving it. Choose OpenWhispr Cloud or Bring Your Own Key to turn it off.`,
  off: `On-Device turns on Local Mode: dictation stays on this ${deviceLabel} and notes ask before leaving it.`,
};

// What Local Mode means for note formatting and chat, which run on this iPhone first.
export const ON_DEVICE_MODE_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  ...(Platform.OS === 'android'
    ? {
        upload: 'Local Mode keeps uploads on this phone.',
        cleanup:
          'In Local Mode, cleanup runs on this phone, or sends only the transcript text to your provider with Bring Your Own Key. OpenWhispr Cloud cleanup is skipped until Local Mode is off.',
      }
    : {}),
  notes: `Local Mode formats notes on this ${deviceLabel} and asks before sending one to your choice here.`,
  agent: `In Local Mode the voice assistant is off, and note chat asks before sending a note off this ${deviceLabel}.`,
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

// Local Mode dictates on this iPhone, so cleaning with OpenWhispr Cloud is a separate Cloud pass,
// which needs a signed-in account.
export const CLOUD_CLEANUP_NEEDS_ACCOUNT_NOTE =
  'In Local Mode, OpenWhispr Cloud cleans transcripts only for a signed-in account, so cleanup is skipped until you sign in.';

export function cloudAccessFor(user: AuthUser | null): CloudAccess {
  if (!user) return 'none';
  return user.isAnonymous ? 'session' : 'account';
}

// OpenWhispr Cloud is saved for cleanup in Local Mode without an account to run it, so it is skipped
// (snapshotTextInference). Unset cleanup only defaults to Cloud with an account (unsetSelection).
export function cloudCleanupNeedsAccount(
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): boolean {
  return (
    Platform.OS !== 'android' &&
    activeMode === 'private' &&
    config?.inference?.cleanup?.mode === 'openwhispr' &&
    cloudAccess !== 'account'
  );
}

// Cleanup runs On-Device when it is saved as On-Device, or in Local Mode when nothing is saved and
// OpenWhispr Cloud can't clean (unsetSelection).
export function cleanupRunsOnDevice(
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess = 'none',
): boolean {
  if (Platform.OS === 'android') return cleanupSavedOnDevice(config);
  return (
    (config?.inference?.cleanup ?? unsetSelection('cleanup', activeMode, cloudAccess)).mode ===
    'local'
  );
}

export function parseWorkflow(value: unknown): MobileInferenceScope | null {
  return WORKFLOWS.find((scope) => scope === value) ?? null;
}

// What a workflow with no saved selection runs. Local Mode keeps dictation and note formatting on
// this iPhone, and uses OpenWhispr Cloud for uploads and cleanup when the account can, else this
// iPhone. Note chat uses OpenWhispr Cloud when unset in every mode, and Bring Your Own Key
// dictation waits for a provider before cleanup or the agent.
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
  if (scope === 'cleanup') {
    if (!(config?.cleanupEnabled ?? true)) return 'Off';
    if (cleanupRunsOnDevice(config, activeMode, cloudAccess) && onDeviceUnavailable)
      return `Skipped · ${onDeviceUnavailable}`;
    if (cloudCleanupNeedsAccount(config, activeMode, cloudAccess)) return 'Skipped · Sign in';
  }
  const selection = config?.inference?.[scope] ?? unsetSelection(scope, activeMode, cloudAccess);
  if (Platform.OS === 'android' && activeMode === 'private') {
    if (
      scope === 'cleanup' &&
      !['local', 'providers'].includes(config?.inference?.cleanup?.mode ?? '')
    )
      return 'Skipped';
    if (scope === 'upload') return MODE_LABELS.local;
  }
  // Local Mode runs dictation, note formatting and provider note chat on this phone first, whatever
  // is saved; note chat set to OpenWhispr, or not set, goes straight to Cloud. Uploads and cleanup
  // run what is saved for them.
  if (activeMode === 'private' && scope === 'agent' && selection.mode === 'openwhispr')
    return MODE_LABELS.openwhispr;
  if (selection.mode === 'local' && isLocalModelKey(selection.modelId))
    return LOCAL_MODEL_TITLES[selection.modelId];
  if (activeMode === 'private' && scope !== 'upload' && scope !== 'cleanup')
    return MODE_LABELS.local;
  if (selection.mode !== 'providers') return MODE_LABELS[selection.mode];
  if (!selection.providerId) return 'Not set';
  const name = providerDisplayName(selection.providerId);
  return keyMissing ? `${name} · Key missing` : name;
}
