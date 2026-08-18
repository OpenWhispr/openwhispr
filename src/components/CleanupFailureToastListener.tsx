import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import { consumeCleanupFailures, useCleanupFailureStore } from "../stores/cleanupFailureStore";
import { isDictationPanelWindow } from "../utils/windowContext";

/** Tells the user their dictation was pasted raw because AI cleanup failed. */
export default function CleanupFailureToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const pending = useCleanupFailureStore((s) => s.pending);

  useEffect(() => {
    if (pending === 0) return;
    const cause = useCleanupFailureStore.getState().lastMessage;
    // Draining first keeps a re-run of this effect from toasting the same failure twice.
    if (consumeCleanupFailures() === 0) return;
    // The panel may already be hidden after dictation; surface it so the toast is seen.
    if (isDictationPanelWindow()) {
      window.electronAPI?.showDictationPanel?.();
    }
    const description = t("app.toasts.cleanupFailed.description");
    toast({
      title: t("app.toasts.cleanupFailed.title"),
      description: cause ? `${description} ${cause}` : description,
      duration: 10000,
    });
  }, [pending, toast, t]);

  return null;
}
