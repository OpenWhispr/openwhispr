import type { RetryOptions } from '@/lib/retry';
export interface SignalOwner {
  signal?: AbortSignal;
}

export const transcriptionLifecycle = {
  cancellationRequested(_owner: SignalOwner): boolean {
    return false;
  },
  assertCurrent(_owner: SignalOwner): void {},
  cancellationError(_signal?: AbortSignal): Error | null {
    return null;
  },
  signalOptions(_owner: SignalOwner): SignalOwner {
    return {};
  },
  signalArguments(_owner: SignalOwner): [] {
    return [];
  },
  uploadRetryOptions(_signal?: AbortSignal): Pick<RetryOptions, 'shouldRetry'> {
    return {};
  },
  uploadParameters(_context?: string): Record<string, string> {
    return {};
  },
  chunkDuration(_durationMs: number): number {
    return 0;
  },
};
