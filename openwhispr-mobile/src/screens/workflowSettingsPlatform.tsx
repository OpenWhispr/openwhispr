import type React from 'react';
import {
  Platform,
  View,
  type KeyboardAvoidingView,
  type KeyboardAvoidingViewProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { TOptions } from 'i18next';
import type { LocalReasoningReadiness, UserConfig } from '@/types';
import type {
  InferenceMode,
  InferenceSelection,
  MobileInferenceScope,
} from '@/lib/mobileProviders';
import { ProviderExecutionError } from '@/services/providers/ProviderExecution';
import { getLocalReasoningLanguageNote, getLocalReasoningReadiness } from '@/lib/localReasoning';
import {
  CLOUD_CLEANUP_NEEDS_ACCOUNT_NOTE,
  LOCAL_MODE_DICTATION_NOTES,
  ON_DEVICE_MODE_NOTES,
  ON_DEVICE_CLEANUP_UNSUPPORTED_NOTE,
  UNSET_PROVIDER_NOTES,
  cloudCleanupNeedsAccount,
} from '@/lib/aiWorkflows';

export type WorkflowCopy = (key: string, fallback: string, options?: TOptions) => string;
export interface WorkflowModeContext {
  scope: MobileInferenceScope;
  config: UserConfig | null;
  activeMode: Parameters<typeof cloudCleanupNeedsAccount>[1];
  cloudAccess: Parameters<typeof cloudCleanupNeedsAccount>[2];
  selection: InferenceSelection;
  savedSelection: InferenceSelection;
  storedSelection: InferenceSelection;
  speechScope: 'dictation' | 'upload' | null;
  onDeviceWanted: boolean;
  onDeviceUnsupported: string | null;
  lockedByPrivateMode: boolean;
}
export interface WorkflowSettingsPlatform {
  getTextReadiness(scope: MobileInferenceScope): Promise<LocalReasoningReadiness>;
  useCopy(): { copy: WorkflowCopy };
  useVoiceAssistantPrivateMode(): boolean;
  useLayout(): {
    Container: typeof View | typeof KeyboardAvoidingView;
    containerProps: Pick<KeyboardAvoidingViewProps, 'behavior' | 'enabled'>;
    screenProps: { style?: StyleProp<ViewStyle> };
  };
  initialConfigured: boolean | null;
  supportsCredentials: boolean;
  dismissKeyboardOnPaste: boolean;
  deviceLabel: string;
  serverHint: string;
  lockedReason: string;
  fieldProps: { style?: StyleProp<TextStyle> };
  disabledProps(disabled: boolean): { disabled?: boolean };
  labelProps(label: string): { accessibilityLabel?: string };
  confirmationOptions(
    label: string,
    copy: WorkflowCopy,
  ): { destructiveLabel: string; cancelLabel?: string };
  isModeLocked(
    scope: MobileInferenceScope,
    activeMode: WorkflowModeContext['activeMode'],
    mode: InferenceMode,
  ): boolean;
  modeNote(input: WorkflowModeContext, copy: WorkflowCopy): string | undefined;
  unavailableModes(
    scope: MobileInferenceScope,
    activeMode: WorkflowModeContext['activeMode'],
    copy: WorkflowCopy,
  ): Partial<Record<InferenceMode, string>>;
  usesKey(scope: MobileInferenceScope, activeMode: WorkflowModeContext['activeMode']): boolean;
  canSaveWithoutRemovedKey(
    selection: InferenceSelection,
    providerId: string | undefined,
    configured: boolean | null,
    savedSelection: InferenceSelection,
  ): boolean;
  onDeviceStatus(
    readiness: LocalReasoningReadiness | null,
    copy: WorkflowCopy,
    appleStatuses: Partial<Record<LocalReasoningReadiness['status'], string>>,
  ): string | null | undefined;
  textModelFooter(copy: WorkflowCopy): string;
  diagnosticFailure(failure: unknown, copy: WorkflowCopy): string;
  LocalModelSettings?: React.ComponentType<{ copy: WorkflowCopy }>;
}

const fallbackCopy: WorkflowCopy = (_key, fallback) => fallback;

export const workflowSettingsPlatform: WorkflowSettingsPlatform = {
  getTextReadiness: () => getLocalReasoningReadiness({ refresh: true }),
  useCopy: () => ({ copy: fallbackCopy }),
  useVoiceAssistantPrivateMode: () => false,
  useLayout: () => ({ Container: View, containerProps: {}, screenProps: {} }),
  initialConfigured: false,
  supportsCredentials: Platform.OS === 'ios',
  dismissKeyboardOnPaste: true,
  deviceLabel: 'iPhone',
  serverHint: "On iPhone, localhost is this iPhone. Use your server's network address.",
  lockedReason: '',
  fieldProps: {},
  disabledProps: () => ({}),
  labelProps: () => ({}),
  confirmationOptions: (label) => ({ destructiveLabel: label }),
  isModeLocked: (scope, activeMode, mode) =>
    activeMode === 'private' && scope === 'dictation' && mode === 'openwhispr',
  modeNote: (input) => {
    const {
      scope,
      config,
      activeMode,
      cloudAccess,
      selection,
      savedSelection,
      speechScope,
      onDeviceWanted,
      onDeviceUnsupported,
    } = input;
    const modeNote =
      (onDeviceWanted && !speechScope
        ? 'Switches to On-Device once Apple Intelligence is ready, while this page stays open.'
        : undefined) ??
      (scope === 'cleanup' && selection.mode === 'local' && onDeviceUnsupported
        ? ON_DEVICE_CLEANUP_UNSUPPORTED_NOTE
        : undefined) ??
      (scope === 'cleanup' &&
      selection.mode === 'openwhispr' &&
      cloudCleanupNeedsAccount(config, activeMode, cloudAccess)
        ? CLOUD_CLEANUP_NEEDS_ACCOUNT_NOTE
        : undefined) ??
      (activeMode === 'private' ? ON_DEVICE_MODE_NOTES[scope] : undefined) ??
      (activeMode === 'providers' && !config?.inference?.[scope]
        ? UNSET_PROVIDER_NOTES[scope]
        : undefined) ??
      (selection.mode === 'providers' && savedSelection.mode !== 'providers'
        ? activeMode === 'private' && scope === 'dictation'
          ? 'Save to switch to Bring Your Own Key. This turns Local Mode off.'
          : 'Save to switch to Bring Your Own Key.'
        : undefined) ??
      (scope === 'dictation'
        ? LOCAL_MODE_DICTATION_NOTES[activeMode === 'private' ? 'on' : 'off']
        : undefined);
    return modeNote;
  },
  unavailableModes: () => ({}),
  usesKey: () => true,
  canSaveWithoutRemovedKey: () => false,
  onDeviceStatus: (readiness, _copy, appleStatuses) =>
    readiness?.status === 'unsupportedLanguage'
      ? getLocalReasoningLanguageNote(readiness)
      : readiness && appleStatuses[readiness.status],
  textModelFooter: () => 'Runs on Apple Intelligence on this iPhone.',
  diagnosticFailure: (failure) =>
    failure instanceof ProviderExecutionError
      ? failure.message
      : 'Unable to check this provider. Check the endpoint and connection, then try again.',
};
