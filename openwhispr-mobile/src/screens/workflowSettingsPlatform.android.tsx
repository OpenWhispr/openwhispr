import React from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { ProviderExecutionError } from '@/services/providers/ProviderExecution';
import { getProviderErrorCopyKey } from '@/lib/providerErrorCopy';
import {
  getLocalReasoningReadiness,
  getLocalReasoningUnavailableMessage,
} from '@/lib/localReasoning';
import { MODE_LABELS } from '@/lib/inferenceModes';
import {
  CLOUD_CLEANUP_NEEDS_ACCOUNT_NOTE,
  LOCAL_MODE_DICTATION_NOTES,
  ON_DEVICE_MODE_NOTES,
  ON_DEVICE_CLEANUP_UNSUPPORTED_NOTE,
  UNSET_PROVIDER_NOTES,
  cloudCleanupNeedsAccount,
} from '@/lib/aiWorkflows';
import { workflowModeRestrictions } from '@/lib/workflowModeRestrictions';
import type { WorkflowCopy, WorkflowSettingsPlatform } from './workflowSettingsPlatform';

const PROVIDER_IDENTIFIER_STYLE = { writingDirection: 'ltr', textAlign: 'left' } as const;

function LocalModelSettings({ copy }: { copy: WorkflowCopy }): React.JSX.Element {
  return (
    <SettingsSection title={copy('workflowSettings.onDeviceModels', 'On-device models')}>
      <SettingsRow
        icon="arrow.down.circle"
        mdIcon="Download"
        title={copy('workflowSettings.chooseModels', 'Choose or download models')}
        description={copy(
          'workflowSettings.chooseModelsBody',
          'Choose speech and text models for this phone.',
        )}
        onPress={() => router.push('/(account)/ai-models')}
      />
    </SettingsSection>
  );
}

export const workflowSettingsPlatform: WorkflowSettingsPlatform = {
  getTextReadiness: (scope) =>
    getLocalReasoningReadiness({
      refresh: true,
      ...(scope === 'cleanup' ? { localModelPurpose: 'cleanup' as const } : {}),
    }),
  useCopy: useAndroidCopy,
  useVoiceAssistantPrivateMode: () =>
    useProcessingModeStore((state) => state.activeMode === 'private'),
  useLayout: () => {
    const keyboardHeight = useKeyboardHeight();
    const insets = useSafeAreaInsets();
    return {
      Container: KeyboardAvoidingView,
      containerProps: { behavior: 'padding', enabled: keyboardHeight > 0 },
      screenProps: { style: { marginBottom: insets.bottom } },
    };
  },
  initialConfigured: null,
  supportsCredentials: true,
  dismissKeyboardOnPaste: false,
  deviceLabel: 'phone',
  serverHint: "On this phone, localhost is this phone. Use your server's network address.",
  lockedReason: workflowModeRestrictions.lockedReason,
  fieldProps: { style: PROVIDER_IDENTIFIER_STYLE },
  disabledProps: (disabled) => ({ disabled }),
  labelProps: (accessibilityLabel) => ({ accessibilityLabel }),
  confirmationOptions: (destructiveLabel, copy) => ({
    destructiveLabel,
    cancelLabel: copy('cancel', 'Cancel'),
  }),
  isModeLocked: (scope, activeMode, mode) =>
    activeMode === 'private' && !!workflowModeRestrictions.lockedModes[scope]?.includes(mode),
  modeNote: (input, copy) => {
    const {
      scope,
      config,
      activeMode,
      cloudAccess,
      selection,
      savedSelection,
      storedSelection,
      speechScope,
      onDeviceWanted,
      onDeviceUnsupported,
      lockedByPrivateMode,
    } = input;
    const localNote = ON_DEVICE_MODE_NOTES[scope]
      ? copy(`workflowSettings.localMode_${scope}`, ON_DEVICE_MODE_NOTES[scope])
      : undefined;
    const storedModeLabel = copy(
      `workflowSettings.${storedSelection.mode === 'providers' ? 'byok' : storedSelection.mode === 'openwhispr' ? 'cloud' : 'local'}`,
      MODE_LABELS[storedSelection.mode],
    );
    const modeNote =
      (Platform.OS === 'ios' && onDeviceWanted && !speechScope
        ? 'Switches to On-Device once Apple Intelligence is ready, while this page stays open.'
        : undefined) ??
      (scope === 'cleanup' && selection.mode === 'local' && onDeviceUnsupported
        ? copy('workflowSettings.localUnavailable', ON_DEVICE_CLEANUP_UNSUPPORTED_NOTE)
        : undefined) ??
      (Platform.OS === 'android' && lockedByPrivateMode && ON_DEVICE_MODE_NOTES[scope]
        ? copy(
            'workflowSettings.modeRestored',
            `${ON_DEVICE_MODE_NOTES[scope]} Your ${MODE_LABELS[storedSelection.mode]} choice applies again when Local Mode is off.`,
            { note: localNote, mode: storedModeLabel },
          )
        : undefined) ??
      (scope === 'cleanup' &&
      selection.mode === 'openwhispr' &&
      cloudCleanupNeedsAccount(config, activeMode, cloudAccess)
        ? CLOUD_CLEANUP_NEEDS_ACCOUNT_NOTE
        : undefined) ??
      (activeMode === 'private' ? localNote : undefined) ??
      (activeMode === 'providers' && !config?.inference?.[scope] && UNSET_PROVIDER_NOTES[scope]
        ? copy(`workflowSettings.unsaved_${scope}`, UNSET_PROVIDER_NOTES[scope])
        : undefined) ??
      (selection.mode === 'providers' && savedSelection.mode !== 'providers'
        ? activeMode === 'private' && scope === 'dictation'
          ? copy(
              'workflowSettings.switchProviderLocal',
              'Save to switch to Bring Your Own Key. This turns Local Mode off.',
            )
          : copy('workflowSettings.switchProvider', 'Save to switch to Bring Your Own Key.')
        : undefined) ??
      (scope === 'dictation'
        ? copy(
            activeMode === 'private'
              ? 'workflowSettings.localDictationOn'
              : 'workflowSettings.localDictationOff',
            LOCAL_MODE_DICTATION_NOTES[activeMode === 'private' ? 'on' : 'off'],
          )
        : undefined);
    return modeNote;
  },
  unavailableModes: (scope, activeMode, copy) =>
    activeMode === 'private'
      ? Object.fromEntries(
          (workflowModeRestrictions.lockedModes[scope] ?? []).map((mode) => [
            mode,
            copy('workflowSettings.localLocked', workflowModeRestrictions.lockedReason),
          ]),
        )
      : {},
  usesKey: (scope, activeMode) => !(activeMode === 'private' && scope === 'agent'),
  canSaveWithoutRemovedKey: (selection, providerId, configured, savedSelection) =>
    selection.mode === 'providers' &&
    providerId === 'custom' &&
    configured === false &&
    !!savedSelection.credentialRef,
  onDeviceStatus: (readiness) =>
    readiness && readiness.status !== 'ready'
      ? getLocalReasoningUnavailableMessage(readiness)
      : undefined,
  textModelFooter: (copy) =>
    copy('workflowSettings.localModelBody', 'Runs on your downloaded text model on this phone.'),
  diagnosticFailure: (failure, copy) => {
    const providerFailure = failure instanceof ProviderExecutionError ? failure : undefined;
    const key = providerFailure && getProviderErrorCopyKey(providerFailure);
    return copy(
      key ?? 'workflowSettings.checkFailed',
      'Unable to check this provider. Check the endpoint and connection, then try again.',
      { status: providerFailure?.status },
    );
  },
  LocalModelSettings,
};
