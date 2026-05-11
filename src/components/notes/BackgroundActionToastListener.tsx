import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/useToast";
import {
  useActionProcessingStore,
  consumeCompletionEvents,
} from "../../stores/actionProcessingStore";

/**
 * Headless component that watches for background action completion events
 * and shows toast notifications. Mount once near the app root (inside
 * ToastProvider) so toasts fire even when the user has navigated away from
 * the notes view.
 */
export default function BackgroundActionToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  // Subscribe to the completionEvents array length — when it changes, consume events.
  const eventCount = useActionProcessingStore((s) => s.completionEvents.length);

  useEffect(() => {
    if (eventCount === 0) return;
    const events = consumeCompletionEvents();
    for (const event of events) {
      if (event.type === "error") {
        toast({
          title: t("notes.enhance.title"),
          description: event.message ?? t("notes.actions.errors.actionFailed"),
          variant: "destructive",
        });
      }
      // Success events don't need a toast — the overlay animation in NoteEditor
      // handles the in-view case, and the note is already persisted to DB for
      // the navigated-away case (user will see updated content when they return).
    }
  }, [eventCount, toast, t]);

  return null;
}
