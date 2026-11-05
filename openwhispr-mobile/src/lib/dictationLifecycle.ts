import type { KeyboardTone, TranscriptionRequest } from '@/types';
import type { DictationProcessingLifecycle } from './transcribeAndCleanup';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { isToneApplicable } from './keyboardTone';

export function cleanupToneForRequest(request: TranscriptionRequest): KeyboardTone | undefined {
  if (request.requestContext !== 'keyboard') return undefined;
  if (!request.keyboardTone || request.keyboardTone === 'default') return undefined;
  if (request.cleanupRoute?.mode === 'local') return undefined;
  const { activeMode } = useProcessingModeStore.getState();
  if (!isToneApplicable(activeMode, useConfigStore.getState().config?.cleanupEnabled)) {
    return undefined;
  }
  return request.keyboardTone;
}

export function prepareDictation(
  request: TranscriptionRequest,
  lifecycle: DictationProcessingLifecycle,
): [TranscriptionRequest, DictationProcessingLifecycle] {
  return [request, lifecycle];
}
export function transcriptionOnly(_lifecycle: DictationProcessingLifecycle): boolean {
  return false;
}
