import type { InferenceSelection } from '@shared/ai/routing';
import { MODE_LABELS } from '@/lib/inferenceModes';
import { providerDisplayName, type MobileInferenceScope } from '@/lib/mobileProviders';
import type { ProcessingMode, UserConfig } from '@/types';

export const WORKFLOW_LABELS: Record<MobileInferenceScope, string> = {
  dictation: 'Dictation & Keyboard',
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

export function parseWorkflow(value: unknown): MobileInferenceScope {
  return WORKFLOWS.find((scope) => scope === value) ?? 'dictation';
}

// What a workflow with no saved selection runs: On-Device mode keeps everything
// local, and Bring Your Own Key dictation waits for a provider before cleanup or the agent.
export function unsetSelection(
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
): InferenceSelection {
  if (activeMode === 'private') return { mode: 'local' };
  if (activeMode === 'providers' && (scope === 'dictation' || UNSET_PROVIDER_NOTES[scope]))
    return { mode: 'providers' };
  return { mode: 'openwhispr' };
}

export function workflowSummary(
  config: UserConfig | null,
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
): string {
  const selection = config?.inference?.[scope] ?? unsetSelection(scope, activeMode);
  if (selection.mode !== 'providers') return MODE_LABELS[selection.mode];
  return selection.providerId ? providerDisplayName(selection.providerId) : 'Not set';
}
