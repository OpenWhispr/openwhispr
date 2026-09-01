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
    const state = useCleanupFailureStore.getState();
    const failure = state.lastFailure ?? { message: state.lastMessage };
    // Draining first keeps a re-run of this effect from toasting the same failure twice.
    if (consumeCleanupFailures() === 0) return;
    // The panel may already be hidden after dictation; surface it so the toast is seen.
    if (isDictationPanelWindow()) {
      window.electronAPI?.showDictationPanel?.();
    }
    toast({
      title: failure.message || t("app.toasts.cleanupFailed.title"),
      secondaryDescription: t("app.toasts.cleanupFailed.description"),
      technicalDetails: failure.technicalDetails,
      variant: "destructive",
      duration: 10000,
    });
  }, [pending, toast, t]);

  return null;
}
