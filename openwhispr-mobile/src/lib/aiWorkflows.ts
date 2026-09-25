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

// What On-Device mode means for each workflow other than dictation.
export const ON_DEVICE_MODE_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  upload:
    'On-Device mode keeps this on your iPhone. Your choice applies when dictation leaves On-Device.',
  notes:
    'On-Device mode formats notes on this iPhone and asks before sending one to your choice here.',
  cleanup:
    'On-Device mode keeps the raw transcript, so cleanup is skipped. Your choice applies when dictation leaves On-Device.',
  agent:
    'In On-Device mode the voice assistant is off, and note chat asks before sending a note off this iPhone.',
};

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
  keyMissing = false,
): string {
  // On-Device mode skips cleanup and runs everything else on this phone first, whatever
  // is saved. Only note chat set to OpenWhispr, or not set, goes straight to Cloud.
  if (activeMode === 'private') {
    if (scope === 'cleanup') return 'Skipped';
    const chatOnCloud = (config?.inference?.agent?.mode ?? 'openwhispr') === 'openwhispr';
    if (scope === 'agent' && chatOnCloud) return MODE_LABELS.openwhispr;
  }
  const selection = config?.inference?.[scope] ?? unsetSelection(scope, activeMode);
  if (selection.mode === 'local' && isLocalModelKey(selection.modelId))
    return LOCAL_MODEL_TITLES[selection.modelId];
  if (activeMode === 'private') return MODE_LABELS.local;
  if (selection.mode !== 'providers') return MODE_LABELS[selection.mode];
  if (!selection.providerId) return 'Not set';
  const name = providerDisplayName(selection.providerId);
  return keyMissing ? `${name} · Key missing` : name;
}
