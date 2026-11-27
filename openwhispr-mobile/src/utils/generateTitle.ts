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

const WRAPPING_QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;
const HEADING_MARKS = /^#{1,6}\s+/;
const PAIRED_EMPHASIS = /(\*\*|__)(.+?)\1/g;
const WRAPPING_MARKS = /^([*_`])(.+)\1$/;

/**
 * Models, the on-device one especially, often answer in Markdown despite the prompt, and the
 * title is shown as plain text, so `**Title**` would keep its asterisks.
 */
export function cleanGeneratedTitle(raw: string): string {
  let title = raw.trim().replace(WRAPPING_QUOTES, '').trim();
  title = title.replace(HEADING_MARKS, '').replace(PAIRED_EMPHASIS, '$2').trim();
  const wrapped = WRAPPING_MARKS.exec(title);
  if (wrapped) title = wrapped[2].trim();
  title = title.replace(WRAPPING_QUOTES, '').trim();
  return /^[*_`#\s]*$/.test(title) ? '' : title;
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
      inferenceScope: 'notes',
      text: text.slice(0, MAX_INPUT_CHARS),
      systemPrompt: TITLE_SYSTEM_PROMPT,
      temperature: 0.3,
      routing,
    });
    const cleaned = cleanGeneratedTitle(result.text);
    return cleaned.length > 0 && cleaned.length < MAX_TITLE_CHARS ? cleaned : '';
  } catch {
    return '';
  }
}
