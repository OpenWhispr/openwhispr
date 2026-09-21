import { Alert } from 'react-native';
import { router } from 'expo-router';
import {
  clearLocalReasoningReadinessCache,
  getLocalReasoningUnavailableMessage,
} from '@/lib/localReasoning';
import { useConfigStore } from '@/store/useConfigStore';
import type { LocalReasoningReadiness } from '@/types';

type FallbackCallback = () => void | Promise<void>;

interface PromptLocalReasoningFallbackOptions {
  readiness: LocalReasoningReadiness;
  signedIn: boolean;
  onEnableLocal?: FallbackCallback;
  onUseCloudOnce?: FallbackCallback;
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
}: PromptLocalReasoningFallbackOptions): void {
  const message = getLocalReasoningUnavailableMessage(readiness);
  const canEnableLocal = readiness.status === 'disabled' && onEnableLocal;
  const canUseCloud = signedIn && onUseCloudOnce;
  const buttons = [
    { text: 'Cancel', style: 'cancel' as const },
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
            text: 'Use Cloud Once',
            onPress: () => run(onUseCloudOnce),
          },
        ]
      : [
          {
            text: 'Account',
            onPress: () => router.push('/(account)'),
          },
        ]),
  ];

  Alert.alert(
    'Local AI unavailable',
    canUseCloud
      ? `${message} Send this note to cloud AI for this request instead?`
      : `${message} Sign in to use cloud AI, or try again later.`,
    buttons,
  );
}
