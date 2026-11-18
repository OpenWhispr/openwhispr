import { buildActionSystemPrompt } from '@/lib/notes/generateNotesPrompt.android';
import {
  prepareAndroidActionPrompt,
  useAndroidActionProcessingLifecycle,
} from '@/android/actionProcessingLifecycle';
import {
  useActionProcessingCore,
  type UseActionProcessingOptions,
} from './useActionProcessingCore';
export type { ProcessingState } from './useActionProcessingCore';
export type { AndroidRunActionOptions as RunActionOptions } from '@/android/actionProcessingLifecycle';

export function useActionProcessing(options: UseActionProcessingOptions) {
  return useActionProcessingCore(
    options,
    useAndroidActionProcessingLifecycle,
    buildActionSystemPrompt,
    prepareAndroidActionPrompt,
  );
}
