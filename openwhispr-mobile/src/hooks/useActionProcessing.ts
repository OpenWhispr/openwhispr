import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
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
import {
  DESKTOP_DEFAULT_NOTE_ACTION,
  isNothingToSummarizeReply,
} from '@/lib/notes/desktopDefaultNotesPrompt';
import type { ReasoningRoutingOptions } from '@/types';
import { unwrapGeneratedMarkdown } from '@/lib/notes/unwrapGeneratedMarkdown';

export type ProcessingState = 'idle' | 'processing' | 'success';

export interface RunActionOptions {
  inputKind?: GenerateNotesInputKind;
  /** Dictionary hints by tier (buildDictationHintTiers): personal, space, workspace. */
  dictionaryTiers?: string[][];
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
  const requestRef = useRef<AbortController | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    },
    [],
  );

  const runAction = useCallback(
    async (action: Action, noteContent: string, options: RunActionOptions = {}) => {
      if (processingRef.current || options.isCurrent?.() === false) return;
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      processingRef.current = true;
      const controller = new AbortController();
      requestRef.current = controller;
      const isCurrent = () =>
        requestRef.current === controller &&
        !controller.signal.aborted &&
        options.isCurrent?.() !== false;

      setActionName(action.name);
      setState('processing');

      try {
        const inputKind = options.inputKind ?? 'plain-note';
        const usesDesktopDefaultNotes =
          Platform.OS === 'android' &&
          inputKind === 'plain-note' &&
          isDefaultGenerateNotesAction(action);
        const actionPrompt = usesDesktopDefaultNotes ? DESKTOP_DEFAULT_NOTE_ACTION : action.prompt;
        const buildPrompt = ({ personal, shared }: LlmDictionary): string =>
          buildActionSystemPrompt({
            actionPrompt,
            inputKind,
            isDefaultGenerateNotesAction: isDefaultGenerateNotesAction(action),
            customDictionary: personal,
            sharedDictionary: shared,
            desktopDefaultNotes: usesDesktopDefaultNotes,
          });
        const tiers = options.dictionaryTiers ?? [];
        const placement = { inferenceScope: 'notes' as const, routing: options.routing };
        // Shared hints must fit alongside the note in the selected local model's context.
        const dictionary = resolveReasoningPlacement(placement).localRequired
          ? await fitDictionaryOnDevice(tiers, (candidate) => ({
              instructions: buildPrompt(candidate),
              prompt: noteContent,
            }))
          : splitLlmDictionary(tiers);
        if (!isCurrent()) return;
        const systemPrompt = buildPrompt(dictionary);
        const cfg = useConfigStore.getState().config;

        const result = await ReasoningService.processText({
          ...placement,
          text: noteContent,
          systemPrompt,
          temperature: 0.3,
          signal: controller.signal,
        });

        if (!isCurrent()) return;

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
          const title = await generateNoteTitle(
            enhancedContent,
            options.routing,
            controller.signal,
          );
          if (!isCurrent()) return;
          if (title) generatedTitle = title;
        }

        setState('success');
        onSuccess(enhancedContent, actionPrompt, generatedTitle);

        successTimerRef.current = setTimeout(() => {
          if (requestRef.current === controller) setState('idle');
        }, 600);
      } catch (e) {
        if (!isCurrent()) return;
        setState('idle');
        onError(e instanceof Error ? e.message : 'Enhancement failed', e);
      } finally {
        // A cancelled request may settle after its replacement has already started.
        if (requestRef.current === controller) {
          if (options.isCurrent?.() === false) setState('idle');
          processingRef.current = false;
        }
      }
    },
    [onSuccess, onError],
  );

  const cancel = useCallback(() => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    requestRef.current?.abort();
    requestRef.current = null;
    processingRef.current = false;
    setState('idle');
  }, []);

  return { state, actionName, runAction, cancel };
}
