import type { ReasoningRequest } from '@/types';
import type { ProviderPrompt } from '@/services/reasoning/buildProviderPrompt';
import type { SignalOwner } from '@/services/transcription/transcriptionLifecycle';

export function createTimeoutSignal(
  timeoutMs: number,
  _options: SignalOwner,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeout),
  };
}

export function localCleanupInstructions(
  _request: ReasoningRequest,
  prompt: ProviderPrompt,
): string {
  return prompt.systemPrompt;
}
