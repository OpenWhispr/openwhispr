import { Alert, Platform } from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import {
  accountRequiredForCloud,
  requiresRealAccount,
  showAccountRequiredAlert,
} from '@/lib/accountAccess';
import { cloudAccessFor, workflowSelection, workflowSummary } from '@/lib/aiWorkflows';
import { localSelection, workflowSaveConfig } from '@/lib/inferenceModes';
import {
  canRunLocalReasoning,
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

type SpeechScope = 'dictation' | 'upload';

// 'needs-model' means the model list was opened because nothing on this phone can run it yet.
// 'not-ready' means Apple Intelligence is off in iOS Settings or still downloading its model.
export type ModeSwitchResult = 'switched' | 'needs-model' | 'not-ready' | 'refused';

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
    router.push(Platform.OS === 'android' ? '/(account)/ai-models' : '/(account)/model-download');
    return 'needs-model';
  }
  return null;
}

async function localTextModelReady(): Promise<ModeSwitchResult | null> {
  const readiness = await getLocalReasoningReadiness({ refresh: true });
  if (readiness.status === 'ready') return null;
  const message = getLocalReasoningUnavailableMessage(readiness);
  if (!canRunLocalReasoning(readiness)) {
    Alert.alert('On-Device Unavailable', message);
    return 'refused';
  }
  // Changing the iPhone's language restarts every app, so this page can't wait for it.
  if (readiness.status === 'unsupportedLanguage') {
    Alert.alert('On-Device Unavailable', `${message} Then come back and choose On-Device again.`);
    return 'refused';
  }
  Alert.alert(
    'On-Device Unavailable',
    Platform.OS === 'android'
      ? message
      : `${message} Keep this page open and On-Device turns on once Apple Intelligence is ready.`,
  );
  return Platform.OS === 'android' ? 'refused' : 'not-ready';
}

// On-Device dictation keeps only dictation on this iPhone, so turning it on offers to move note
// formatting here too, while Apple Intelligence can run it.
async function offerOnDeviceNoteFormatting(): Promise<void> {
  const { config } = useConfigStore.getState();
  const cloudAccess = cloudAccessFor(useAuthStore.getState().user);
  if (workflowSelection(config, 'notes', 'private', cloudAccess).mode === 'local') return;
  if ((await getLocalReasoningReadiness()).status !== 'ready') return;
  const current = workflowSummary(config, 'notes', 'private', { cloudAccess });
  Alert.alert(
    'Format notes on this iPhone too?',
    `Dictation now stays on this iPhone. Note formatting and titles still use ${current}.`,
    [
      { text: 'Not Now', style: 'cancel' },
      {
        text: 'Use On-Device',
        onPress: (): void => {
          switchWorkflowMode('notes', 'local').catch(() => undefined);
        },
      },
    ],
  );
}

// Applies OpenWhispr Cloud or On-Device to a workflow as soon as it is tapped, after its sign-in
// and model checks. Dictation carries the app mode with it: On-Device turns Local Mode on.
export async function switchWorkflowMode(
  scope: MobileInferenceScope,
  mode: 'openwhispr' | 'local',
): Promise<ModeSwitchResult> {
  const { user } = useAuthStore.getState();
  if (mode === 'openwhispr' && accountRequiredForCloud(user)) {
    showAccountRequiredAlert(isSpeechScope(scope) ? 'cloud transcription' : 'cloud AI');
    return 'refused';
  }
  // Outside Cloud dictation, Cloud cleanup is a separate pass that needs an account.
  if (
    mode === 'openwhispr' &&
    scope === 'cleanup' &&
    useProcessingModeStore.getState().activeMode !== 'cloud' &&
    requiresRealAccount(user)
  ) {
    showAccountRequiredAlert('cloud cleanup');
    return 'refused';
  }
  if (mode === 'local') {
    const blocked = isSpeechScope(scope)
      ? await transcriptionModelReady()
      : await localTextModelReady();
    if (blocked) return blocked;
  }

  const { config, updateConfig } = useConfigStore.getState();
  const { activeMode, setActiveMode } = useProcessingModeStore.getState();
  if (scope === 'dictation') setActiveMode(mode === 'local' ? 'private' : 'cloud', true);
  const selection: InferenceSelection =
    mode === 'local' ? localSelection(config, scope) : { mode: 'openwhispr' };
  await updateConfig(
    workflowSaveConfig(config, scope, selection, activeMode, cloudAccessFor(user)),
  );
  if (
    Platform.OS === 'ios' &&
    scope === 'dictation' &&
    mode === 'local' &&
    activeMode !== 'private'
  )
    offerOnDeviceNoteFormatting().catch(() => undefined);
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
  const { getProviderCredentialStatus } =
    require('@/services/providers/ProviderCredentials') as typeof import('@/services/providers/ProviderCredentials');
  const { getProviderPolicy } =
    require('@/services/providers/ProviderPolicy') as typeof import('@/services/providers/ProviderPolicy');
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
// remembered so switching back to On-Device restores it.
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
    // A picked model is the user's own choice, so onboarding never releases it.
    ...(config?.pinnedInference
      ? { pinnedInference: config.pinnedInference.filter((pinned) => pinned !== scope) }
      : {}),
  });
}
