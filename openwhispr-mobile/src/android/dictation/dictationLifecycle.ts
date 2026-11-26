import type { KeyboardTone, TranscriptionRequest } from '@/android/types';
import type { DictationProcessingLifecycle } from '@/android/dictation/transcribeAndCleanup';
import { useConfigStore } from '@/android/store/useConfigStore';
import { abortError } from '@/services/providers/NativeProviderTransport';

export function cleanupToneForRequest(request: TranscriptionRequest): KeyboardTone | undefined {
  if (request.requestContext !== 'keyboard') return undefined;
  if (!request.keyboardTone || request.keyboardTone === 'default') return undefined;
  const cleanupEnabled = useConfigStore.getState().config?.cleanupEnabled;
  return (cleanupEnabled ?? true) ? request.keyboardTone : undefined;
}
export function prepareDictation(
  request: TranscriptionRequest,
  lifecycle: DictationProcessingLifecycle,
): [TranscriptionRequest, DictationProcessingLifecycle] {
  const signal = lifecycle.signal ?? request.signal;
  if (signal?.aborted) throw abortError('Transcription cancelled.');
  return [
    { ...request, signal },
    { ...lifecycle, signal },
  ];
}
export function transcriptionOnly(lifecycle: DictationProcessingLifecycle): boolean {
  return !!lifecycle.transcriptionOnly;
}
