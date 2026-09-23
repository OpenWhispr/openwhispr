import { AppleLLM } from '@/lib/appleLLM';
import { LOCAL_OUTPUT_TOKEN_RESERVE, toLocalReasoningError } from '@/lib/localReasoning';
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
      const result = await AppleLLM.generateText({
        instructions,
        prompt: request.text,
        temperature: request.temperature,
        maxTokens: request.maxTokens ?? LOCAL_OUTPUT_TOKEN_RESERVE,
      });

      if (__DEV__) {
        console.log(
          `[reasoning] provider=local model=apple-fm elapsedMs=${Date.now() - startedAt}`,
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
