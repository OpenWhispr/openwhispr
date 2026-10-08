import type { InferenceSelection } from '@/lib/mobileProviders';
import { MODE_LABELS } from '@/lib/inferenceModes';
import { isLocalModelKey, LOCAL_MODEL_TITLES } from '@/lib/localModelCatalog';
import { providerDisplayName, type MobileInferenceScope } from '@/lib/mobileProviders';
import type { ProcessingMode, UserConfig } from '@/types';

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

// On-Device mode skips cleanup until On-Device or a provider is saved for it, so the unset
// page picks nothing.
export const UNSET_ON_DEVICE_CLEANUP_NOTE =
  'Not saved yet. On-Device mode skips cleanup until you choose On-Device or Bring Your Own Key.';

// The same, on an iPhone that can never run On-Device cleanup.
export const UNSET_UNSUPPORTED_CLEANUP_NOTE =
  "Not saved yet. This iPhone can't run On-Device cleanup, so On-Device mode skips it until you choose Bring Your Own Key.";

// What On-Device mode means for each workflow other than dictation.
export const ON_DEVICE_MODE_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  upload:
    'On-Device mode keeps this on your iPhone. Your choice applies when dictation leaves On-Device.',
  notes:
    'On-Device mode formats notes on this iPhone and asks before sending one to your choice here.',
  cleanup:
    'In On-Device mode, cleanup runs on this iPhone, or sends only the transcript text to your provider with Bring Your Own Key. OpenWhispr Cloud cleanup is skipped until dictation leaves On-Device.',
  agent:
    'In On-Device mode the voice assistant is off, and note chat asks before sending a note off this iPhone.',
};

// A local transcript is cleaned on the phone when cleanup is saved as On-Device.
export function cleanupSavedOnDevice(config: UserConfig | null): boolean {
  return config?.inference?.cleanup?.mode === 'local';
}

// A local transcript is also cleaned by a provider saved for cleanup, which is the user's
// consent to send it the text; unset or Cloud would take it off the phone unasked.
export function cleansLocalTranscripts(config: UserConfig | null): boolean {
  const mode = config?.inference?.cleanup?.mode;
  return mode === 'local' || mode === 'providers';
}

export function parseWorkflow(value: unknown): MobileInferenceScope | null {
  return WORKFLOWS.find((scope) => scope === value) ?? null;
}

// What a workflow with no saved selection runs: On-Device mode keeps everything
// local except note chat, which uses OpenWhispr Cloud when unset in every mode, and
// Bring Your Own Key dictation waits for a provider before cleanup or the agent.
export function unsetSelection(
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
): InferenceSelection {
  if (activeMode === 'private')
    return scope === 'agent' ? { mode: 'openwhispr' } : { mode: 'local' };
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
  }: {
    keyMissing?: boolean;
    // Why Apple Intelligence can't run right now, when it can't.
    onDeviceUnavailable?: string;
  } = {},
): string {
  if (scope === 'cleanup') {
    if (!(config?.cleanupEnabled ?? true)) return 'Off';
    if (cleanupSavedOnDevice(config) && onDeviceUnavailable)
      return `${MODE_LABELS.local} · ${onDeviceUnavailable}`;
  }
  // On-Device mode runs everything on this phone first, whatever is saved. Cleanup runs
  // only when set to On-Device or a provider, and only note chat set to OpenWhispr, or
  // not set, goes straight to Cloud.
  if (activeMode === 'private') {
    if (scope === 'cleanup' && !cleansLocalTranscripts(config)) return 'Skipped';
    const chatOnCloud = (config?.inference?.agent?.mode ?? 'openwhispr') === 'openwhispr';
    if (scope === 'agent' && chatOnCloud) return MODE_LABELS.openwhispr;
  }
  const selection = config?.inference?.[scope] ?? unsetSelection(scope, activeMode);
  if (selection.mode === 'local' && isLocalModelKey(selection.modelId))
    return LOCAL_MODEL_TITLES[selection.modelId];
  if (activeMode === 'private' && !(scope === 'cleanup' && selection.mode === 'providers'))
    return MODE_LABELS.local;
  if (selection.mode !== 'providers') return MODE_LABELS[selection.mode];
  if (!selection.providerId) return 'Not set';
  const name = providerDisplayName(selection.providerId);
  return keyMissing ? `${name} · Key missing` : name;
}
