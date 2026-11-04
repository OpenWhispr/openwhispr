import { androidCopy } from '@/lib/androidCopy';

const upstream = require('./privateMode.ts') as typeof import('./privateMode');
export const { getPrivateModeReadiness, promptLocalModelFallback } = upstream;
export type { PrivateModeStatus, PrivateModeReadiness } from './privateMode';

export function getPrivateModeUnavailableMessage(): string {
  return androidCopy(
    'workflowAlerts.speechUnavailable',
    'On-device transcription is unavailable on this device.',
  );
}
