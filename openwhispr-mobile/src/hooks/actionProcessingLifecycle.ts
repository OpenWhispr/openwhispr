import { useMemo, useRef } from 'react';
import { generateNoteTitle } from '@/utils/generateTitle';
import type {
  ActionProcessingLifecycle,
  ProcessingState,
  RunActionOptions,
} from './useActionProcessingCore';

export function useActionProcessingLifecycle(
  setState: (state: ProcessingState) => void,
): ActionProcessingLifecycle<RunActionOptions> {
  const processingRef = useRef(false);
  const cancelledRef = useRef(false);
  return useMemo(
    () => ({
      start: () => {
        if (processingRef.current) return null;
        processingRef.current = true;
        cancelledRef.current = false;
        return {
          isCurrent: () => !cancelledRef.current,
          shouldGenerateTitle: () => true,
          generateTitle: generateNoteTitle,
          scheduleIdle: () => {
            setTimeout(() => setState('idle'), 600);
          },
          finish: () => {
            processingRef.current = false;
          },
        };
      },
      cancel: () => {
        cancelledRef.current = true;
        processingRef.current = false;
        setState('idle');
      },
    }),
    [setState],
  );
}
