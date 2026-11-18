import { useState, useCallback } from 'react';
import { ReasoningService, resolveReasoningPlacement } from '@/services/reasoning/ReasoningService';
import { useConfigStore } from '@/store/useConfigStore';
import {
  isDefaultGenerateNotesAction,
  type GenerateNotesInputKind,
  type BuildActionSystemPromptInput,
} from '@/lib/notes/generateNotesPromptCore';
import { fitDictionaryOnDevice } from '@/lib/onDeviceDictionary';
import { splitLlmDictionary, type LlmDictionary } from '@/lib/snippets';
import type { Action } from '@/data';
import type { ReasoningRoutingOptions } from '@/types';

export type ProcessingState = 'idle' | 'processing' | 'success';
export interface RunActionOptions {
  inputKind?: GenerateNotesInputKind;
  dictionaryTiers?: string[][];
  routing?: ReasoningRoutingOptions;
}
export interface UseActionProcessingOptions {
  onSuccess: (enhancedContent: string, prompt: string, generatedTitle?: string) => void;
  onError: (message: string, error: unknown) => void;
}
export interface ActionProcessingRequest {
  isCurrent: () => boolean;
  reasoningOptions?: { signal: AbortSignal };
  shouldGenerateTitle: () => boolean;
  generateTitle: (text: string, routing?: ReasoningRoutingOptions) => Promise<string>;
  scheduleIdle: () => void;
  finish: () => void;
}
export interface ActionProcessingLifecycle<Options extends RunActionOptions> {
  start: (options: Options) => ActionProcessingRequest | null;
  cancel: () => void;
}
export interface PreparedActionPrompt {
  actionPrompt: string;
  promptOptions?: { desktopDefaultNotes: boolean };
  processResult?: (text: string) => string;
}

export function useActionProcessingCore<Options extends RunActionOptions>(
  { onSuccess, onError }: UseActionProcessingOptions,
  useLifecycle: (setState: (state: ProcessingState) => void) => ActionProcessingLifecycle<Options>,
  buildActionSystemPrompt: (input: BuildActionSystemPromptInput) => string,
  prepareActionPrompt?: (action: Action, inputKind: GenerateNotesInputKind) => PreparedActionPrompt,
) {
  const [state, setState] = useState<ProcessingState>('idle');
  const [actionName, setActionName] = useState('');
  const lifecycle = useLifecycle(setState);
  const runAction = useCallback(
    async (action: Action, noteContent: string, options: Options = {} as Options) => {
      const request = lifecycle.start(options);
      if (!request) return;
      setActionName(action.name);
      setState('processing');
      try {
        const inputKind = options.inputKind ?? 'plain-note';
        const prepared = prepareActionPrompt?.(action, inputKind) ?? {
          actionPrompt: action.prompt,
        };
        const buildPrompt = ({ personal, shared }: LlmDictionary): string =>
          buildActionSystemPrompt({
            actionPrompt: prepared.actionPrompt,
            inputKind,
            isDefaultGenerateNotesAction: isDefaultGenerateNotesAction(action),
            customDictionary: personal,
            sharedDictionary: shared,
            ...prepared.promptOptions,
          });
        const tiers = options.dictionaryTiers ?? [];
        const placement = { inferenceScope: 'notes' as const, routing: options.routing };
        const dictionary = resolveReasoningPlacement(placement).localRequired
          ? await fitDictionaryOnDevice(tiers, (candidate) => ({
              instructions: buildPrompt(candidate),
              prompt: noteContent,
            }))
          : splitLlmDictionary(tiers);
        if (!request.isCurrent()) return;
        const systemPrompt = buildPrompt(dictionary);
        const cfg = useConfigStore.getState().config;
        const result = await ReasoningService.processText({
          ...placement,
          text: noteContent,
          systemPrompt,
          temperature: 0.3,
          ...request.reasoningOptions,
        });
        if (!request.isCurrent()) return;
        const enhancedContent = prepared.processResult
          ? prepared.processResult(result.text)
          : result.text;
        let generatedTitle: string | undefined;
        if ((cfg?.autoGenerateNoteTitle ?? true) && request.shouldGenerateTitle()) {
          const title = await request.generateTitle(enhancedContent, options.routing);
          if (!request.isCurrent()) return;
          if (title) generatedTitle = title;
        }
        setState('success');
        onSuccess(enhancedContent, prepared.actionPrompt, generatedTitle);
        request.scheduleIdle();
      } catch (error) {
        if (!request.isCurrent()) return;
        setState('idle');
        onError(error instanceof Error ? error.message : 'Enhancement failed', error);
      } finally {
        request.finish();
      }
    },
    [onSuccess, onError, lifecycle, buildActionSystemPrompt, prepareActionPrompt],
  );
  return { state, actionName, runAction, cancel: lifecycle.cancel };
}
