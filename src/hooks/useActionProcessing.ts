import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import reasoningService from "../services/ReasoningService";
import type { ActionItem } from "../types/electron";
import { getEffectiveReasoningModel } from "../stores/settingsStore";

export type ActionProcessingState = "idle" | "processing" | "success";

const BASE_SYSTEM_PROMPT =
  "You are a note enhancement assistant. The user will provide raw notes — possibly voice-transcribed, rough, or unstructured. Your job is to clean them up according to the instructions below while preserving all original meaning and information. Output clean markdown.\n\nInstructions: ";

interface UseActionProcessingOptions {
  onSuccess: (enhancedContent: string, prompt: string) => void;
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
      options: { isCloudMode: boolean; modelId: string }
    ) => {
      if (processingRef.current) return;

      const modelId = getEffectiveReasoningModel() || options.modelId;

      if (!modelId && !options.isCloudMode) {
        onError(t("notes.actions.errors.noModel"));
        return;
      }

      cancelledRef.current = false;
      processingRef.current = true;
      setActionName(action.name);
      setState("processing");

      try {
        const systemPrompt = BASE_SYSTEM_PROMPT + action.prompt;
        const enhanced = await reasoningService.processText(noteContent, modelId, null, {
          systemPrompt,
          temperature: 0.3,
        });

        if (cancelledRef.current) return;

        setState("success");
        onSuccess(enhanced, action.prompt);

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
