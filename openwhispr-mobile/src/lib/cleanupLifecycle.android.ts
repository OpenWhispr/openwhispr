import type { ReasoningRequest } from '@/types';
import type { ProviderPrompt } from '@/services/reasoning/buildProviderPrompt';
import type { SignalOwner } from '@/services/transcription/transcriptionLifecycle';
import { buildLocalReasoningInstructions } from '@/services/reasoning/LocalReasoningService';

export function createTimeoutSignal(
  timeoutMs: number,
  options: SignalOwner,
): { signal: AbortSignal; cancel: () => void } {
  const parent = options.signal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export function localCleanupInstructions(
  request: ReasoningRequest,
  prompt: ProviderPrompt,
): string {
  return buildLocalReasoningInstructions({ ...request, ...prompt });
}
