import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import reasoningService from "../services/ReasoningService";
import type { ActionItem } from "../types/electron";
import { getEffectiveCleanupModel, getSettings } from "../stores/settingsStore";
import { generateNoteTitle } from "../utils/generateTitle";

export type ActionProcessingState = "idle" | "processing" | "success";

const BASE_SYSTEM_PROMPT = `You are a note enhancement assistant. The user will provide raw notes — possibly voice-transcribed, rough, or unstructured. Your job is to clean them up according to the instructions below while preserving all original meaning and information. Output clean markdown.

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no date/time/location, no attendee list, no topic header. Start directly with the content.
- Do NOT use tables, horizontal rules, or block quotes.
- Do NOT list or guess participant names/roles.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

const MEETING_SYSTEM_PROMPT = `You are a professional meeting notes assistant. You will receive a dual-speaker transcript where "You:" marks the user's speech and "Them:" marks the other participant(s), along with any manual notes the user took.

Your job is to produce clean, actionable meeting notes in markdown. Follow these rules:

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no "# Meeting Notes", no date/time/location, no attendee list, no topic header. Start directly with the summary.
- Do NOT use tables, horizontal rules, or block quotes.
- Do NOT list or guess participant names/roles.
- Start with a concise 1–2 sentence summary of what the meeting was about.
- Use clear section headings: ## Key Discussion Points, ## Decisions Made, ## Action Items, ## Follow-ups (omit any section that has no content).
- Under Action Items, use checkboxes (\`- [ ]\`) and attribute each item to "You" or "Them" where clear.

CONTENT RULES:
- Preserve important quotes or specific commitments verbatim when they carry meaning.
- Remove filler, small talk, false starts, and repeated/redundant content.
- Where speakers refer to the same topic across multiple turns, consolidate into a coherent point rather than listing every utterance.
- If the user included manual notes alongside the transcript, integrate them — they represent the user's emphasis on what matters most.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

interface UseActionProcessingOptions {
  onSuccess: (enhancedContent: string, prompt: string, title?: string) => void;
  onError: (errorMessage: string) => void;
}

export function useActionProcessing({ onSuccess, onError }: UseActionProcessingOptions) {
  const { t } = useTranslation();
  const [state, setState] = useState<ActionProcessingState>("idle");
  const [actionName, setActionName] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const successTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const processingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);

  const runAction = useCallback(
    async (
      action: ActionItem,
      noteContent: string,
      options: { isCloudMode: boolean; modelId: string; isMeetingNote?: boolean }
    ) => {
      if (processingRef.current) return;

      const modelId = getEffectiveCleanupModel() || options.modelId;

      if (!modelId && !options.isCloudMode) {
        onError(t("notes.actions.errors.noModel"));
        return;
      }

      cancelledRef.current = false;
      processingRef.current = true;
      setActionName(action.name);
      setState("processing");

      try {
        const basePrompt = options.isMeetingNote ? MEETING_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
        const systemPrompt = basePrompt + action.prompt;
        const enhanced = await reasoningService.processText(noteContent, modelId, null, {
          systemPrompt,
          temperature: 0.3,
          disableThinking: getSettings().noteFormattingDisableThinking,
        });

        if (cancelledRef.current) return;

        let title: string | undefined;
        if (getSettings().autoGenerateNoteTitle) {
          const generated = await generateNoteTitle(enhanced, modelId);
          if (generated) title = generated;
        }

        if (cancelledRef.current) return;

        setState("success");
        onSuccess(enhanced, action.prompt, title);

        successTimeoutRef.current = setTimeout(() => {
          processingRef.current = false;
          setState("idle");
          setActionName(null);
        }, 600);
      } catch (err) {
        if (cancelledRef.current) return;
        processingRef.current = false;
        setState("idle");
        setActionName(null);
        onError(err instanceof Error ? err.message : t("notes.actions.errors.actionFailed"));
      }
    },
    [onSuccess, onError, t]
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    processingRef.current = false;
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
      successTimeoutRef.current = null;
    }
    setState("idle");
    setActionName(null);
  }, []);

  return { state, actionName, runAction, cancel };
}
