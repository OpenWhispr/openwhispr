import { buildActionSystemPrompt } from '@/lib/notes/generateNotesPrompt';
import { useActionProcessingLifecycle } from './actionProcessingLifecycle';
import {
  useActionProcessingCore,
  type UseActionProcessingOptions,
} from './useActionProcessingCore';
export type { ProcessingState, RunActionOptions } from './useActionProcessingCore';

export function useActionProcessing(options: UseActionProcessingOptions) {
  return useActionProcessingCore(options, useActionProcessingLifecycle, buildActionSystemPrompt);
}
