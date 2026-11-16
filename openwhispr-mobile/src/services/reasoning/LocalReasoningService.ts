import { AppleLLM } from '@/lib/appleLLM';
import {
  LOCAL_OUTPUT_TOKEN_RESERVE,
  countLocalReasoningTokens,
  estimateLocalTokens,
  toLocalReasoningError,
} from '@/lib/localReasoning';
import type { ReasoningRequest, ReasoningResponse } from '@/types';

// Callers fold language, tone and dictionary into the system prompt first
// (buildProviderPrompt), so the instructions are that prompt alone.
export function buildLocalReasoningInstructions(request: ReasoningRequest): string {
  return request.systemPrompt?.trim() ?? '';
}

export class LocalReasoningService {
  static async processText(request: ReasoningRequest): Promise<ReasoningResponse> {
    const instructions = buildLocalReasoningInstructions(request);
    if (!instructions) {
      throw new Error('Local reasoning requires explicit instructions.');
    }

    try {
      const startedAt = Date.now();
      const result = await AppleLLM.generateText(
        {
          instructions,
          prompt: request.text,
          temperature: request.temperature,
          maxTokens: request.maxTokens ?? LOCAL_OUTPUT_TOKEN_RESERVE,
        },
        { signal: request.signal },
      );

      if (__DEV__) {
        // The rate the On-Device cleanup timeout assumes (cleanupTranscript); it includes reading
        // the prompt, and is estimated from length where iOS can't count tokens (before 26.4).
        const elapsedMs = Date.now() - startedAt;
        const counted = await countLocalReasoningTokens({ prompt: result.text });
        const outputTokens = counted ?? estimateLocalTokens(result.text);
        console.log(
          `[reasoning] provider=local model=apple-fm elapsedMs=${elapsedMs} outputTokens=${outputTokens}${
            counted === null ? ' (estimated)' : ''
          } tokensPerSecond=${(outputTokens / Math.max(elapsedMs / 1000, 0.001)).toFixed(1)}`,
        );
      }

      return {
        text: result.text.trim(),
        model: 'apple-fm',
      };
    } catch (error) {
      throw toLocalReasoningError(error);
    }
  }
}
