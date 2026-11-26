import type { ReasoningRoutingOptions } from '@/android/types';
import { generateNoteTitleCore } from '@/android/utils/generateTitleCore';
export { deriveLocalTitle } from '@/android/utils/generateTitleCore';

export function generateNoteTitle(
  text: string,
  routing?: ReasoningRoutingOptions,
  signal?: AbortSignal,
): Promise<string> {
  return generateNoteTitleCore(text, routing, { signal });
}
