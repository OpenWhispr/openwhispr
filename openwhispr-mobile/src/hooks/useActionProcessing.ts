import { useState, useRef, useCallback } from 'react';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { useConfigStore } from '@/store/useConfigStore';
import { generateNoteTitle } from '@/utils/generateTitle';
import {
  buildActionSystemPrompt,
  isDefaultGenerateNotesAction,
  type GenerateNotesInputKind,
} from '@/lib/notes/generateNotesPrompt';
import type { Action } from '@/data';
import type { ReasoningRoutingOptions } from '@/types';

export type ProcessingState = 'idle' | 'processing' | 'success';

export interface RunActionOptions {
  inputKind?: GenerateNotesInputKind;
  customDictionary?: string[];
  routing?: ReasoningRoutingOptions;
}

interface UseActionProcessingOptions {
  onSuccess: (enhancedContent: string, prompt: string, generatedTitle?: string) => void;
  // The raw error rides along so callers can branch on a server code
  // (ACCOUNT_REQUIRED) rather than pattern-matching the message.
  onError: (message: string, error: unknown) => void;
}

export function useActionProcessing({ onSuccess, onError }: UseActionProcessingOptions) {
  const [state, setState] = useState<ProcessingState>('idle');
  const [actionName, setActionName] = useState('');
  const processingRef = useRef(false);
  const cancelledRef = useRef(false);

  const runAction = useCallback(
    async (action: Action, noteContent: string, options: RunActionOptions = {}) => {
      if (processingRef.current) return;
      processingRef.current = true;
      cancelledRef.current = false;

      setActionName(action.name);
      setState('processing');

      try {
        const systemPrompt = buildActionSystemPrompt({
          actionPrompt: action.prompt,
          inputKind: options.inputKind ?? 'plain-note',
          isDefaultGenerateNotesAction: isDefaultGenerateNotesAction(action),
          customDictionary: options.customDictionary,
        });
        const cfg = useConfigStore.getState().config;

        const result = await ReasoningService.processText({
          text: noteContent,
          systemPrompt,
          temperature: 0.3,
          routing: options.routing,
        });

        if (cancelledRef.current) return;

        let generatedTitle: string | undefined;
        if (cfg?.autoGenerateNoteTitle ?? true) {
          const title = await generateNoteTitle(result.text, options.routing);
          if (cancelledRef.current) return;
          if (title) generatedTitle = title;
        }

        setState('success');
        onSuccess(result.text, action.prompt, generatedTitle);

        setTimeout(() => {
          setState('idle');
        }, 600);
      } catch (e) {
        if (cancelledRef.current) return;
        setState('idle');
        onError(e instanceof Error ? e.message : 'Enhancement failed', e);
      } finally {
        processingRef.current = false;
      }
    },
    [onSuccess, onError],
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    processingRef.current = false;
    setState('idle');
  }, []);

  return { state, actionName, runAction, cancel };
}
