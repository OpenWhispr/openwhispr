import { useEffect, useMemo, useRef } from 'react';
import { generateNoteTitle } from '@/utils/generateTitle.android';
import {
  isDefaultGenerateNotesAction,
  type GenerateNotesInputKind,
} from '@/lib/notes/generateNotesPromptCore';
import {
  DESKTOP_DEFAULT_NOTE_ACTION,
  isNothingToSummarizeReply,
} from '@/lib/notes/desktopDefaultNotesPrompt';
import { unwrapGeneratedMarkdown } from '@/lib/notes/unwrapGeneratedMarkdown';
import type { Action } from '@/data';
import type {
  ActionProcessingLifecycle,
  PreparedActionPrompt,
  ProcessingState,
  RunActionOptions,
} from '@/hooks/useActionProcessingCore';

export interface AndroidRunActionOptions extends RunActionOptions {
  isCurrent?: () => boolean;
  shouldGenerateTitle?: () => boolean;
}

export function prepareAndroidActionPrompt(
  action: Action,
  inputKind: GenerateNotesInputKind,
): PreparedActionPrompt {
  const usesDesktopDefaultNotes =
    inputKind === 'plain-note' && isDefaultGenerateNotesAction(action);
  return {
    actionPrompt: usesDesktopDefaultNotes ? DESKTOP_DEFAULT_NOTE_ACTION : action.prompt,
    promptOptions: { desktopDefaultNotes: usesDesktopDefaultNotes },
    processResult: (text) => {
      const content = isDefaultGenerateNotesAction(action) ? unwrapGeneratedMarkdown(text) : text;
      if (usesDesktopDefaultNotes && isNothingToSummarizeReply(content)) {
        throw new Error(
          'There is no substantive content to summarize. Your original note is unchanged.',
        );
      }
      return content;
    },
  };
}

export function useAndroidActionProcessingLifecycle(
  setState: (state: ProcessingState) => void,
): ActionProcessingLifecycle<AndroidRunActionOptions> {
  const processingRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    },
    [],
  );
  return useMemo(
    () => ({
      start: (options) => {
        if (processingRef.current || options.isCurrent?.() === false) return null;
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        processingRef.current = true;
        const controller = new AbortController();
        requestRef.current = controller;
        return {
          isCurrent: () =>
            requestRef.current === controller &&
            !controller.signal.aborted &&
            options.isCurrent?.() !== false,
          reasoningOptions: { signal: controller.signal },
          shouldGenerateTitle: () => options.shouldGenerateTitle?.() !== false,
          generateTitle: (text, routing) => generateNoteTitle(text, routing, controller.signal),
          scheduleIdle: () => {
            successTimerRef.current = setTimeout(() => {
              if (requestRef.current === controller) setState('idle');
            }, 600);
          },
          finish: () => {
            // A cancelled request may settle after its replacement has already started.
            if (requestRef.current === controller) {
              if (options.isCurrent?.() === false) setState('idle');
              processingRef.current = false;
            }
          },
        };
      },
      cancel: () => {
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        requestRef.current?.abort();
        requestRef.current = null;
        processingRef.current = false;
        setState('idle');
      },
    }),
    [setState],
  );
}
