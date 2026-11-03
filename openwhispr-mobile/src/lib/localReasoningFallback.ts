import { Alert, Platform } from 'react-native';
import { router } from 'expo-router';
import {
  clearLocalReasoningReadinessCache,
  getLocalReasoningUnavailableMessage,
} from '@/lib/localReasoning';
import { useConfigStore } from '@/store/useConfigStore';
import type { LocalReasoningReadiness } from '@/types';
import type { useAndroidCopy } from '@/hooks/useAndroidCopy';

type FallbackCallback = () => void | Promise<void>;

interface PromptLocalReasoningFallbackOptions {
  readiness: LocalReasoningReadiness;
  signedIn: boolean;
  onEnableLocal?: FallbackCallback;
  onUseCloudOnce?: FallbackCallback;
  // The user's own provider, when that is where this request would go instead of Cloud.
  destinationName?: string;
  copy?: ReturnType<typeof useAndroidCopy>['copy'];
}

function run(callback: FallbackCallback | undefined): void {
  if (!callback) return;
  Promise.resolve(callback()).catch(() => {});
}

export function promptLocalReasoningFallback({
  readiness,
  signedIn,
  onEnableLocal,
  onUseCloudOnce,
  destinationName,
  copy = (_key, fallback) => fallback,
}: PromptLocalReasoningFallbackOptions): void {
  const message =
    Platform.OS === 'android'
      ? copy('editorFeedback.downloadLocal', getLocalReasoningUnavailableMessage(readiness))
      : getLocalReasoningUnavailableMessage(readiness);
  const canEnableLocal = Platform.OS === 'ios' && readiness.status === 'disabled' && onEnableLocal;
  // A provider takes the user's own key, so it needs no OpenWhispr account.
  const canUseCloud = (signedIn || !!destinationName) && onUseCloudOnce;
  const buttons = [
    { text: copy('cancel', 'Cancel'), style: 'cancel' as const },
    ...(Platform.OS === 'android'
      ? [
          {
            text: copy('editorFeedback.models', 'Models'),
            onPress: () => router.push('/(account)/ai-models'),
          },
        ]
      : []),
    ...(canEnableLocal
      ? [
          {
            text: 'Enable Local AI',
            onPress: () => {
              useConfigStore
                .getState()
                .updateConfig({ appleLocalIntelligenceEnabled: true })
                .then(() => {
                  clearLocalReasoningReadinessCache();
                  run(onEnableLocal);
                })
                .catch(() => {
                  Alert.alert(
                    'Could not update setting',
                    'Try enabling Local Apple Intelligence from Account settings.',
                  );
                });
            },
          },
        ]
      : []),
    ...(canUseCloud
      ? [
          {
            text: copy('editorFeedback.useDestination', `Use ${destinationName ?? 'Cloud'} Once`, {
              destination: destinationName ?? copy('editorFeedback.cloudName', 'Cloud'),
            }),
            onPress: () => run(onUseCloudOnce),
          },
        ]
      : [
          {
            text: copy('account', 'Account'),
            onPress: () => router.push('/(account)'),
          },
        ]),
  ];

  Alert.alert(
    copy('editorFeedback.localUnavailable', 'Local AI unavailable'),
    canUseCloud
      ? copy(
          'editorFeedback.fallbackBody',
          `${message} Send this note to ${destinationName ?? 'cloud AI'} for this request instead?`,
          { message, destination: destinationName ?? copy('editorFeedback.cloudAI', 'cloud AI') },
        )
      : copy(
          'editorFeedback.fallbackSignIn',
          `${message} Sign in to use cloud AI, or try again later.`,
          { message },
        ),
    buttons,
  );
}
