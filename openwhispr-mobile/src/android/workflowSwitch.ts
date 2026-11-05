import { Alert } from 'react-native';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { workflowSaveConfig } from '@/lib/inferenceModes';
import { androidCopy } from '@/lib/androidCopy';
import { getLocalReasoningReadiness } from '@/lib/localReasoning';
import { resolveMobileInferenceRoute, type InferenceSelection } from '@/lib/mobileProviders';
import type { UserConfig } from '@/types';
import type {
  createWorkflowModeSwitch,
  ModeSwitchResult,
  WorkflowModeSwitchPolicy,
} from '../lib/workflowModeSwitchCore';

function showOnDeviceUnavailable(message: string): void {
  const title = androidCopy('workflowAlerts.unavailableTitle', 'On-Device Unavailable');
  Alert.alert(title, message, [{ text: androidCopy('done', 'Done') }]);
}

export const androidWorkflowSwitchPolicy: WorkflowModeSwitchPolicy = {
  showOnDeviceUnavailable,
  readinessFailedMessage: () =>
    androidCopy('workflowAlerts.readinessFailed', 'Unable to check the local model right now.'),
  modelDownloadRoute: '/(account)/ai-models',
  refuseUnavailableText: true,
  skipNoteFormattingOffer: true,
  getTextReadiness: (scope) =>
    getLocalReasoningReadiness({
      refresh: true,
      ...(scope === 'cleanup' ? { localModelPurpose: 'cleanup' as const } : {}),
    }),
};

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

export function createAndroidPrivateModeToggle(
  switchWorkflowMode: ReturnType<typeof createWorkflowModeSwitch>['switchWorkflowMode'],
) {
  // The Private mode switch in AI Models. On keeps dictation and uploads on this phone; off hands
  // dictation back to Cloud, or to Bring Your Own Key when that is where Private mode was turned on
  // and the provider can still run.
  return async function setPrivateMode(enabled: boolean): Promise<ModeSwitchResult> {
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
  };
}
