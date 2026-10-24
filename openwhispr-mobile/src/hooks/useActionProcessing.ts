import { useState, useRef, useCallback } from 'react';
import { Platform } from 'react-native';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { useConfigStore } from '@/store/useConfigStore';
import { generateNoteTitle } from '@/utils/generateTitle';
import {
  buildActionSystemPrompt,
  isDefaultGenerateNotesAction,
  type GenerateNotesInputKind,
} from '@/lib/notes/generateNotesPrompt';
import type { Action } from '@/data';
import {
  DESKTOP_DEFAULT_NOTE_ACTION,
  isNothingToSummarizeReply,
} from '@/lib/notes/desktopDefaultNotesPrompt';
import type { ReasoningRoutingOptions } from '@/types';
import { unwrapGeneratedMarkdown } from '@/lib/notes/unwrapGeneratedMarkdown';

export type ProcessingState = 'idle' | 'processing' | 'success';

export interface RunActionOptions {
  inputKind?: GenerateNotesInputKind;
  customDictionary?: string[];
  routing?: ReasoningRoutingOptions;
  /** Recheck ownership after asynchronous work before continuing or publishing a result. */
  isCurrent?: () => boolean;
  /** Recheck whether the editor can still use an automatic title. */
  shouldGenerateTitle?: () => boolean;
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
      if (processingRef.current || options.isCurrent?.() === false) return;
      processingRef.current = true;
      cancelledRef.current = false;

      setActionName(action.name);
      setState('processing');

      try {
        const inputKind = options.inputKind ?? 'plain-note';
        const usesDesktopDefaultNotes =
          Platform.OS === 'android' &&
          inputKind === 'plain-note' &&
          isDefaultGenerateNotesAction(action);
        const actionPrompt = usesDesktopDefaultNotes ? DESKTOP_DEFAULT_NOTE_ACTION : action.prompt;
        const systemPrompt = buildActionSystemPrompt({
          actionPrompt,
          inputKind,
          isDefaultGenerateNotesAction: isDefaultGenerateNotesAction(action),
          customDictionary: options.customDictionary,
          desktopDefaultNotes: usesDesktopDefaultNotes,
        });
        const cfg = useConfigStore.getState().config;

        const result = await ReasoningService.processText({
          inferenceScope: 'notes',
          text: noteContent,
          systemPrompt,
          temperature: 0.3,
          routing: options.routing,
        });

        if (cancelledRef.current || options.isCurrent?.() === false) return;

        const enhancedContent =
          Platform.OS === 'android' && isDefaultGenerateNotesAction(action)
            ? unwrapGeneratedMarkdown(result.text)
            : result.text;

        if (usesDesktopDefaultNotes && isNothingToSummarizeReply(enhancedContent)) {
          throw new Error(
            'There is no substantive content to summarize. Your original note is unchanged.',
          );
        }

        let generatedTitle: string | undefined;
        if ((cfg?.autoGenerateNoteTitle ?? true) && options.shouldGenerateTitle?.() !== false) {
          const title = await generateNoteTitle(enhancedContent, options.routing);
          if (cancelledRef.current || options.isCurrent?.() === false) return;
          if (title) generatedTitle = title;
        }

        setState('success');
        onSuccess(enhancedContent, actionPrompt, generatedTitle);

        setTimeout(() => {
          setState('idle');
        }, 600);
      } catch (e) {
        if (cancelledRef.current || options.isCurrent?.() === false) return;
        setState('idle');
        onError(e instanceof Error ? e.message : 'Enhancement failed', e);
      } finally {
        if (options.isCurrent?.() === false) setState('idle');
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
