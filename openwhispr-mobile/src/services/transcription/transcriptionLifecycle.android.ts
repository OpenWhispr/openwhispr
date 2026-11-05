import { abortError } from '../providers/NativeProviderTransport';
import type { RetryOptions } from '@/lib/retry';
import type { SignalOwner } from './transcriptionLifecycle';

export const transcriptionLifecycle = {
  cancellationRequested(owner: SignalOwner): boolean {
    return !!owner.signal?.aborted;
  },
  assertCurrent(owner: SignalOwner): void {
    if (owner.signal?.aborted) throw abortError('Transcription cancelled.');
  },
  cancellationError(signal?: AbortSignal): Error | null {
    return signal?.aborted ? abortError('Transcription cancelled.') : null;
  },
  signalOptions(owner: SignalOwner): SignalOwner {
    return { signal: owner.signal };
  },
  signalArguments(owner: SignalOwner): [AbortSignal | undefined] {
    return [owner.signal];
  },
  uploadRetryOptions(signal?: AbortSignal): Pick<RetryOptions, 'shouldRetry'> {
    return {
      shouldRetry: (error) =>
        !signal?.aborted && !(error instanceof Error && error.name === 'AbortError'),
    };
  },
  uploadParameters(context?: string, purpose?: string): Record<string, string> {
    if (context !== 'file') return {};
    return purpose === 'meeting'
      ? { source: 'file_upload', androidMeetingRecovery: 'short-wav-v1' }
      : { source: 'file_upload' };
  },
  chunkDuration(durationMs: number): number {
    return durationMs / 1000;
  },
};
