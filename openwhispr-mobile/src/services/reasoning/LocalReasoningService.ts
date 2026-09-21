import { AppleLLM } from '@/lib/appleLLM';
import { LOCAL_OUTPUT_TOKEN_RESERVE, toLocalReasoningError } from '@/lib/localReasoning';
import type { KeyboardTone, ReasoningRequest, ReasoningResponse } from '@/types';

const TONE_INSTRUCTIONS: Partial<Record<KeyboardTone, string>> = {
  formal: 'Use a formal, polished tone.',
  casual: 'Use a casual, conversational tone.',
  very_casual: 'Use a very casual, relaxed tone.',
  excited: 'Use an upbeat, enthusiastic tone.',
};

function appendInstruction(parts: string[], value: string | undefined | null): void {
  const trimmed = value?.trim();
  if (trimmed) parts.push(trimmed);
}

export function buildLocalReasoningInstructions(request: ReasoningRequest): string {
  const parts: string[] = [];
  appendInstruction(parts, request.systemPrompt);

  if (request.language || request.locale) {
    appendInstruction(
      parts,
      `Prefer ${request.language ?? request.locale} language conventions when editing or generating text.`,
    );
  }

  if (request.tone && request.tone !== 'default') {
    appendInstruction(parts, TONE_INSTRUCTIONS[request.tone]);
  }

  if (request.customDictionary && request.customDictionary.length > 0) {
    const words = request.customDictionary.map((word) => word.trim()).filter(Boolean);
    if (words.length > 0) {
      appendInstruction(
        parts,
        `Custom Dictionary: preserve these spellings exactly when they appear: ${words.join(', ')}.`,
      );
    }
  }

  return parts.join('\n\n');
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
