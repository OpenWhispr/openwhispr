import type { ReasoningRoutingOptions } from '@/types';
import { generateNoteTitleCore } from './generateTitleCore';
export { deriveLocalTitle } from './generateTitleCore';

export function generateNoteTitle(
  text: string,
  routing?: ReasoningRoutingOptions,
): Promise<string> {
  return generateNoteTitleCore(text, routing);
}
