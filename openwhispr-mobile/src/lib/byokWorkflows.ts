import { Alert } from 'react-native';
import { router } from 'expo-router';
import { accountRequiredForCloud, showAccountRequiredAlert } from '@/lib/accountAccess';
import type { AuthUser } from '@/lib/authClient';
import { getPrivateModeReadiness, getPrivateModeUnavailableMessage } from '@/lib/privateMode';
import type { InferenceSelection } from '@/lib/mobileProviders';
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

export function parseWorkflow(value: unknown): MobileInferenceScope | null {
  return WORKFLOWS.find((scope) => scope === value) ?? null;
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
  keyMissing = false,
): string {
  // Routing keeps every workflow on this phone in On-Device mode, whatever is saved.
  if (activeMode === 'private') return MODE_LABELS.local;
  const selection = config?.inference?.[scope] ?? unsetSelection(scope, activeMode);
  if (selection.mode !== 'providers') return MODE_LABELS[selection.mode];
  if (!selection.providerId) return 'Not set';
  const name = providerDisplayName(selection.providerId);
  return keyMissing ? `${name} · Key missing` : name;
}

// Every control that moves speech to Cloud or On-Device runs these checks, so none can
// save a mode that fails on the next recording.
export async function confirmSpeechModeReady(
  mode: 'cloud' | 'private',
  user: AuthUser | null,
): Promise<boolean> {
  if (mode === 'cloud') {
    if (!accountRequiredForCloud(user)) return true;
    showAccountRequiredAlert('cloud transcription');
    return false;
  }
  const readiness = await getPrivateModeReadiness().catch(() => null);
  if (!readiness) {
    Alert.alert('On-Device Unavailable', 'Unable to check the local model right now.');
    return false;
  }
  if (readiness.status === 'unavailable') {
    Alert.alert('On-Device Unavailable', getPrivateModeUnavailableMessage());
    return false;
  }
  if (readiness.status === 'missing') {
    Alert.alert(
      'Download required',
      `Download the on-device model (${readiness.modelName}) before switching to on-device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Download', onPress: () => router.push('/(account)/model-download') },
      ],
    );
    return false;
  }
  return true;
}
