import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/useToast";
import { ToastActionButton } from "../ui/Toast";
import {
  useActionProcessingStore,
  consumeAppliedEvents,
  consumeErrorEvents,
  selectNoteActionState,
  type ActionAppliedEvent,
} from "../../stores/actionProcessingStore";
import { getActionName } from "../../stores/actionStore";
import { providerErrorToastProps } from "../../utils/describeProviderError";

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
        title: event.notice ? undefined : t("notes.enhance.title"),
        ...providerErrorToastProps(event, t),
        variant: event.notice ? undefined : "destructive",
      });
    }
  }, [errorCount, toast, t]);

  // Only a note's latest change can be undone: an older Undo would wipe out the newer run.
  const undoToastByNote = useRef(new Map<number, string>());

  // A run starting on the note retires its Undo, since the run may build on what Undo would restore.
  useEffect(
    () =>
      useActionProcessingStore.subscribe((state) => {
        for (const [noteId, toastId] of undoToastByNote.current) {
          if (selectNoteActionState(state, noteId).status !== "processing") continue;
          dismiss(toastId);
          undoToastByNote.current.delete(noteId);
        }
      }),
    [dismiss]
  );

  const offerUndo = useCallback(
    ({ noteId, action, previous }: ActionAppliedEvent) => {
      const toastId = toast({
        title: t("notes.actions.applied", { name: getActionName(action, t) }),
        duration: UNDO_WINDOW_MS,
        action: (
          <ToastActionButton
            onClick={async () => {
              // Writing to a note deleted since would bring it back.
              const note = await window.electronAPI.getNote(noteId);
              if (!note || note.deleted_at) {
                dismiss(toastId);
                return;
              }
              const result = await window.electronAPI.updateNote(noteId, previous);
              if (result?.success) dismiss(toastId);
            }}
          >
            {t("app.toasts.undo")}
          </ToastActionButton>
        ),
      });
      undoToastByNote.current.set(noteId, toastId);
    },
    [toast, dismiss, t]
  );

  // A run can finish while the app is in the background: its short Undo window
  // stays queued until the window has focus instead of running out unseen.
  useEffect(() => {
    const offerQueued = () => {
      if (document.hasFocus()) consumeAppliedEvents().forEach(offerUndo);
    };
    offerQueued();
    window.addEventListener("focus", offerQueued);
    return () => window.removeEventListener("focus", offerQueued);
  }, [appliedCount, offerUndo]);

  return null;
}
