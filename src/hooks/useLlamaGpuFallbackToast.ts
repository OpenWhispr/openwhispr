import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import type { ToastContextType } from "../components/ui/useToast";

/** Announce a reasoning-model GPU fallback in whichever app window is open. */
export function useLlamaGpuFallbackToast(toast: ToastContextType["toast"], t: TFunction): void {
  const visibleReason = useRef<"out_of_memory" | "startup_failed" | null>(null);
  useEffect(() => {
    return window.electronAPI?.onLlamaGpuFallback?.(({ reason }) => {
      if (visibleReason.current === reason) return;
      visibleReason.current = reason;
      toast({
        title: t("gpu.activationFailed"),
        description: t(
          reason === "out_of_memory"
            ? "gpu.reasoningOutOfMemoryDescription"
            : "gpu.reasoningActivationFailedDescription"
        ),
        variant: "destructive",
        duration: 10000,
        onSettled: () => {
          if (visibleReason.current === reason) visibleReason.current = null;
        },
      });
    });
  }, [toast, t]);
}
