import type { ReasoningRoutingOptions } from '@/types';

const TITLE_SYSTEM_PROMPT =
  'Generate a concise 3-8 word title for these notes. Return ONLY the title text, nothing else — no quotes, no prefix, no explanation.';

const MAX_INPUT_CHARS = 2000;
const MAX_TITLE_CHARS = 100;
const LOCAL_TITLE_WORDS = 8;
const TRAILING_TITLE_PUNCTUATION = /[\s.,;:!?]+$/;

export function deriveLocalTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';

  return normalized
    .split(' ')
    .slice(0, LOCAL_TITLE_WORDS)
    .join(' ')
    .slice(0, MAX_TITLE_CHARS)
    .replace(TRAILING_TITLE_PUNCTUATION, '')
    .trim();
}

export async function generateNoteTitle(
  text: string,
  routing?: ReasoningRoutingOptions,
): Promise<string> {
  if (!text.trim()) return '';

  try {
    const { ReasoningService } =
      require('@/services/reasoning/ReasoningService') as typeof import('@/services/reasoning/ReasoningService');
    const result = await ReasoningService.processText({
      text: text.slice(0, MAX_INPUT_CHARS),
      systemPrompt: TITLE_SYSTEM_PROMPT,
      temperature: 0.3,
      routing,
    });
    const cleaned = result.text.trim().replace(/^["']|["']$/g, '');
    return cleaned.length > 0 && cleaned.length < MAX_TITLE_CHARS ? cleaned : '';
  } catch {
    return '';
  }
}
