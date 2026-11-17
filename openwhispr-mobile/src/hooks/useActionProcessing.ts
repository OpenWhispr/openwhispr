import { useState, useRef, useCallback } from 'react';
import { ReasoningService, resolveReasoningPlacement } from '@/services/reasoning/ReasoningService';
import { useConfigStore } from '@/store/useConfigStore';
import { generateNoteTitle } from '@/utils/generateTitle';
import {
  buildActionSystemPrompt,
  isDefaultGenerateNotesAction,
  type GenerateNotesInputKind,
} from '@/lib/notes/generateNotesPrompt';
import { fitDictionaryOnDevice } from '@/lib/onDeviceDictionary';
import { splitLlmDictionary, type LlmDictionary } from '@/lib/snippets';
import type { Action } from '@/data';
import type { ReasoningRoutingOptions } from '@/types';

export type ProcessingState = 'idle' | 'processing' | 'success';

export interface RunActionOptions {
  inputKind?: GenerateNotesInputKind;
  /** Dictionary hints by tier (buildDictationHintTiers): personal, space, workspace. */
  dictionaryTiers?: string[][];
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
        const buildPrompt = ({ personal, shared }: LlmDictionary): string =>
          buildActionSystemPrompt({
            actionPrompt: action.prompt,
            inputKind: options.inputKind ?? 'plain-note',
            isDefaultGenerateNotesAction: isDefaultGenerateNotesAction(action),
            customDictionary: personal,
            sharedDictionary: shared,
          });
        const tiers = options.dictionaryTiers ?? [];
        const placement = { inferenceScope: 'notes' as const, routing: options.routing };
        // On this iPhone the prompt has to fit Apple Intelligence's context with the note.
        const dictionary = resolveReasoningPlacement(placement).localRequired
          ? await fitDictionaryOnDevice(tiers, (candidate) => ({
              instructions: buildPrompt(candidate),
              prompt: noteContent,
            }))
          : splitLlmDictionary(tiers);
        if (cancelledRef.current) return;
        const systemPrompt = buildPrompt(dictionary);
        const cfg = useConfigStore.getState().config;

        const result = await ReasoningService.processText({
          ...placement,
          text: noteContent,
          systemPrompt,
          temperature: 0.3,
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
