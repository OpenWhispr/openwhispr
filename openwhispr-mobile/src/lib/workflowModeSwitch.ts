import { Alert } from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { accountRequiredForCloud, showAccountRequiredAlert } from '@/lib/accountAccess';
import { workflowSaveConfig } from '@/lib/inferenceModes';
import {
  getLocalReasoningReadiness,
  getLocalReasoningUnavailableMessage,
} from '@/lib/localReasoning';
import type { LocalModelKey } from '@/lib/localModelCatalog';
import type { InferenceSelection, MobileInferenceScope } from '@/lib/mobileProviders';
import { getPrivateModeReadiness, getPrivateModeUnavailableMessage } from '@/lib/privateMode';

type SpeechScope = 'dictation' | 'upload';

function isSpeechScope(scope: MobileInferenceScope): scope is SpeechScope {
  return scope === 'dictation' || scope === 'upload';
}

async function transcriptionModelReady(): Promise<boolean> {
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

async function appleIntelligenceReady(): Promise<boolean> {
  const readiness = await getLocalReasoningReadiness({ refresh: true });
  if (readiness.status === 'ready') return true;
  Alert.alert('On-Device Unavailable', getLocalReasoningUnavailableMessage(readiness));
  return false;
}

// Applies OpenWhispr Cloud or On-Device to a workflow as soon as it is tapped, after the same
// sign-in and model checks the Home toggle runs. Returns whether the mode changed.
export async function switchWorkflowMode(
  scope: MobileInferenceScope,
  mode: 'openwhispr' | 'local',
): Promise<boolean> {
  if (mode === 'openwhispr' && accountRequiredForCloud(useAuthStore.getState().user)) {
    showAccountRequiredAlert(isSpeechScope(scope) ? 'cloud transcription' : 'cloud AI');
    return false;
  }
  if (mode === 'local') {
    const ready = isSpeechScope(scope)
      ? await transcriptionModelReady()
      : await appleIntelligenceReady();
    if (!ready) return false;
  }

  const { config, updateConfig } = useConfigStore.getState();
  const { activeMode, setActiveMode } = useProcessingModeStore.getState();
  if (scope === 'dictation') setActiveMode(mode === 'local' ? 'private' : 'cloud', true);
  const selection: InferenceSelection =
    mode === 'local'
      ? (config?.rememberedInference?.[scope]?.local ?? { mode: 'local' })
      : { mode: 'openwhispr' };
  await updateConfig(workflowSaveConfig(config, scope, selection, activeMode));
  return true;
}

// Saves the on-device model for a workflow; undefined means Automatic. The pick is also
// remembered so switching back to On-Device, from here or the Home toggle, restores it.
export async function pickLocalModel(
  scope: SpeechScope,
  model: LocalModelKey | undefined,
): Promise<void> {
  const { config, updateConfig } = useConfigStore.getState();
  const selection: InferenceSelection = model
    ? { mode: 'local', modelId: model }
    : { mode: 'local' };
  await updateConfig({
    inference: { ...config?.inference, [scope]: selection },
    rememberedInference: {
      ...config?.rememberedInference,
      [scope]: { ...config?.rememberedInference?.[scope], local: selection },
    },
    // A picked model is the user's own choice, so leaving Bring Your Own Key keeps it.
    ...(config?.pinnedInference
      ? { pinnedInference: config.pinnedInference.filter((pinned) => pinned !== scope) }
      : {}),
  });
}
