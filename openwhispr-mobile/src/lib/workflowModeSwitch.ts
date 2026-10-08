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
import type { UserConfig } from '@/types';
import {
  resolveMobileInferenceRoute,
  type InferenceSelection,
  type MobileInferenceScope,
} from '@/lib/mobileProviders';
import { getPrivateModeReadiness, getPrivateModeUnavailableMessage } from '@/lib/privateMode';
import { getProviderCredentialStatus } from '@/services/providers/ProviderCredentials';
import { getProviderPolicy } from '@/services/providers/ProviderPolicy';

type SpeechScope = 'dictation' | 'upload';

// 'needs-model' means the model list was opened because nothing on this phone can run it yet.
export type ModeSwitchResult = 'switched' | 'needs-model' | 'refused';

function isSpeechScope(scope: MobileInferenceScope): scope is SpeechScope {
  return scope === 'dictation' || scope === 'upload';
}

async function transcriptionModelReady(): Promise<ModeSwitchResult | null> {
  const readiness = await getPrivateModeReadiness().catch(() => null);
  if (!readiness) {
    Alert.alert('On-Device Unavailable', 'Unable to check the local model right now.');
    return 'refused';
  }
  if (readiness.status === 'unavailable') {
    Alert.alert('On-Device Unavailable', getPrivateModeUnavailableMessage());
    return 'refused';
  }
  // Nothing to run yet: open the model list, where every on-device model can be
  // downloaded.
  if (readiness.status === 'missing') {
    router.push('/(account)/model-download');
    return 'needs-model';
  }
  return null;
}

async function appleIntelligenceReady(): Promise<boolean> {
  const readiness = await getLocalReasoningReadiness({ refresh: true });
  if (readiness.status === 'ready') return true;
  Alert.alert('On-Device Unavailable', getLocalReasoningUnavailableMessage(readiness));
  return false;
}

// Applies OpenWhispr Cloud or On-Device to a workflow as soon as it is tapped, after the same
// sign-in and model checks Private mode runs.
export async function switchWorkflowMode(
  scope: MobileInferenceScope,
  mode: 'openwhispr' | 'local',
): Promise<ModeSwitchResult> {
  if (mode === 'openwhispr' && accountRequiredForCloud(useAuthStore.getState().user)) {
    showAccountRequiredAlert(isSpeechScope(scope) ? 'cloud transcription' : 'cloud AI');
    return 'refused';
  }
  if (mode === 'local') {
    const blocked = isSpeechScope(scope)
      ? await transcriptionModelReady()
      : (await appleIntelligenceReady())
        ? null
        : 'refused';
    if (blocked) return blocked;
  }

  const { config, updateConfig } = useConfigStore.getState();
  const { activeMode, setActiveMode } = useProcessingModeStore.getState();
  if (scope === 'dictation') setActiveMode(mode === 'local' ? 'private' : 'cloud', true);
  const selection: InferenceSelection =
    mode === 'local'
      ? (config?.rememberedInference?.[scope]?.local ?? { mode: 'local' })
      : { mode: 'openwhispr' };
  await updateConfig(workflowSaveConfig(config, scope, selection, activeMode));
  return 'switched';
}

// The provider turning Private mode off returns dictation to: the one dictation is saved to, or
// the last one used when Private mode was turned on from Bring Your Own Key.
function returnProvider(config: UserConfig | null): InferenceSelection | undefined {
  const saved = config?.inference?.dictation;
  if (saved?.mode === 'providers') return saved;
  if (!config?.privateModeReturn) return undefined;
  return Object.values(config.rememberedInference?.dictation ?? {}).find(
    (selection) => selection.mode === 'providers',
  );
}

// A provider whose key was removed, or that the organization no longer allows, can't take
// dictation back. A policy still loading doesn't count against it.
async function providerUsable(selection: InferenceSelection): Promise<boolean> {
  const resolved = resolveMobileInferenceRoute({
    scope: 'dictation',
    selection,
    policy: await getProviderPolicy(),
  });
  if (!resolved.ok) return resolved.code === 'POLICY_UNRESOLVED';
  if (!selection.credentialRef) return true;
  const status = await getProviderCredentialStatus(selection.credentialRef).catch(() => ({
    isConfigured: true,
  }));
  return status.isConfigured;
}

// The Private mode switch in AI Models. On keeps dictation and uploads on this phone; off hands
// dictation back to Cloud, or to Bring Your Own Key when that is where Private mode was turned on
// and the provider can still run.
export async function setPrivateMode(enabled: boolean): Promise<ModeSwitchResult> {
  if (enabled) return switchWorkflowMode('dictation', 'local');
  const { config, updateConfig } = useConfigStore.getState();
  const provider = returnProvider(config);
  if (provider && (await providerUsable(provider))) {
    const { activeMode, setActiveMode } = useProcessingModeStore.getState();
    setActiveMode('providers', true);
    await updateConfig(workflowSaveConfig(config, 'dictation', provider, activeMode));
    return 'switched';
  }
  return switchWorkflowMode('dictation', 'openwhispr');
}

// Saves the on-device model for a workflow; undefined means Automatic. The pick is also
// remembered so switching back to On-Device, from here or Private mode, restores it.
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
