import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/useToast";
import { ToastActionButton } from "../ui/Toast";
import {
  useActionProcessingStore,
  consumeAppliedEvents,
  consumeErrorEvents,
} from "../../stores/actionProcessingStore";
import { getActionName } from "../../stores/actionStore";

const UNDO_WINDOW_MS = 6000;

/**
 * Headless. Mount once inside ToastProvider so background-action results and
 * errors surface even after the user navigates away from the notes view.
 */
export default function BackgroundActionToastListener() {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();

  const errorCount = useActionProcessingStore((s) => s.errorEvents.length);
  const appliedCount = useActionProcessingStore((s) => s.appliedEvents.length);

  useEffect(() => {
    if (errorCount === 0) return;
    for (const event of consumeErrorEvents()) {
      toast({
        title: t("notes.enhance.title"),
        description: event.messageKey ? t(event.messageKey, event.messageParams) : event.message,
        variant: "destructive",
      });
    }
  }, [errorCount, toast, t]);

  useEffect(() => {
    if (appliedCount === 0) return;
    for (const { noteId, action, previous } of consumeAppliedEvents()) {
      const toastId = toast({
        title: t("notes.actions.applied", { name: getActionName(action, t) }),
        duration: UNDO_WINDOW_MS,
        action: (
          <ToastActionButton
            onClick={async () => {
              const result = await window.electronAPI.updateNote(noteId, previous);
              if (result?.success) dismiss(toastId);
            }}
          >
            {t("app.toasts.undo")}
          </ToastActionButton>
        ),
      });
    }
  }, [appliedCount, toast, dismiss, t]);

  return null;
}
