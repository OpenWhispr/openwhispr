import { useEffect } from "react";
import type { TFunction } from "i18next";
import type { ToastContextType } from "../components/ui/useToast";

/**
 * Surfaces main-process notifications (hotkey fallback/failure, GPU fallback,
 * learned dictionary corrections) as toasts in the dictation window.
 */
export function useMainProcessNotifications({
  toast,
  dismiss,
  t,
}: {
  toast: ToastContextType["toast"];
  dismiss: ToastContextType["dismiss"];
  t: TFunction;
}): void {
  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyChanged.title"),
        description: t("app.toasts.hotkeyChanged.description", {
          original: data.original,
          fallback: data.fallback,
        }),
        duration: 8000,
      });
    });

    // Main's translated reason names the hotkey, which matters when several slots
    // restore at startup.
    const unsubscribeFailed = window.electronAPI?.onHotkeyRegistrationFailed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyUnavailable.title"),
        description: data?.error || t("app.toasts.hotkeyUnavailable.description"),
        duration: 10000,
      });
    });

    const showGpuFallbackToast = () => {
      let toastId: string;
      toastId = toast({
        title: t("app.toasts.gpuFallback.title"),
        description: t("app.toasts.gpuFallback.description"),
        duration: 10000,
        actions: [
          {
            label: t("app.toasts.gpuFallback.retry"),
            icon: "retry",
            dismissOnClick: false,
            onClick: async () => {
              try {
                const result = await window.electronAPI?.whisperGpuRetry?.();
                if (result?.success) dismiss(toastId);
              } catch {
                // silently fail — toast stays up for another attempt
              }
            },
          },
        ],
      });
    };
    const unsubscribeCudaFallback =
      window.electronAPI?.onCudaFallbackNotification?.(showGpuFallbackToast);
    const unsubscribeGpuFallback =
      window.electronAPI?.onGpuFallbackNotification?.(showGpuFallbackToast);

    const unsubscribeCorrections = window.electronAPI?.onCorrectionsLearned?.((words) => {
      if (words && words.length > 0) {
        const wordList = words.map((w) => `“${w}”`).join(", ");
        let toastId: string;
        toastId = toast({
          title: t("app.toasts.addedToDict", { words: wordList }),
          variant: "success",
          duration: 6000,
          actions: [
            {
              label: t("app.toasts.undo"),
              dismissOnClick: false,
              onClick: async () => {
                try {
                  const result = await window.electronAPI?.undoLearnedCorrections?.(words);
                  if (result?.success) dismiss(toastId);
                } catch {
                  // silently fail — word stays in dictionary
                }
              },
            },
          ],
        });
      }
    });

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
      unsubscribeCudaFallback?.();
      unsubscribeGpuFallback?.();
      unsubscribeCorrections?.();
    };
  }, [toast, dismiss, t]);
}
