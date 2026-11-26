import { buildActionSystemPrompt } from '@/android/lib/notes/generateNotesPrompt';
import {
  prepareAndroidActionPrompt,
  useAndroidActionProcessingLifecycle,
} from '@/android/actionProcessingLifecycle';
import {
  useActionProcessingCore,
  type UseActionProcessingOptions,
} from '@/android/hooks/useActionProcessingCore';
export type { ProcessingState } from '@/android/hooks/useActionProcessingCore';
export type { AndroidRunActionOptions as RunActionOptions } from '@/android/actionProcessingLifecycle';

export function useActionProcessing(options: UseActionProcessingOptions) {
  return useActionProcessingCore(
    options,
    useAndroidActionProcessingLifecycle,
    buildActionSystemPrompt,
    prepareAndroidActionPrompt,
  );
}
