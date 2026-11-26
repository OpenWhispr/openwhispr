import { androidCopy } from '@/android/shared/lib/androidCopy';

const upstream =
  require('@/android/shared/lib/privateModeBase') as typeof import('@/android/shared/lib/privateModeBase');
export const { getPrivateModeReadiness, promptLocalModelFallback } = upstream;
export type { PrivateModeStatus, PrivateModeReadiness } from '@/android/shared/lib/privateModeBase';

export function getPrivateModeUnavailableMessage(): string {
  return androidCopy(
    'workflowAlerts.speechUnavailable',
    'On-device transcription is unavailable on this device.',
  );
}
