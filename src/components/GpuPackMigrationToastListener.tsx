import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import { isControlPanelWindow } from "../utils/windowContext";

/**
 * One-time notice that a GPU pack was cleared or needs re-downloading, which
 * otherwise degrades to a silent CPU fallback. The notice is persisted by the
 * main process (it happens before any window exists) and taken by the window
 * that shows it: the control panel, or the dictation panel of an app started
 * to the tray, which main tells once the normal app is up (#1606, #2554).
 */
export default function GpuPackMigrationToastListener() {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const activeNotice = useRef<{ id: string; packs: string[] } | null>(null);

  useEffect(() => {
    let disposed = false;
    let checking = false;
    const checkRepaired = async () => {
      const notice = activeNotice.current;
      if (!notice || checking) return;
      checking = true;
      try {
        const repaired = await Promise.all(
          notice.packs.map(async (pack) => {
            const api = window.electronAPI;
            const status =
              pack === "CUDA whisper"
                ? await api?.getCudaWhisperStatus?.()
                : pack === "Vulkan whisper"
                  ? await api?.getVulkanWhisperStatus?.()
                  : pack === "Vulkan llama"
                    ? await api?.getLlamaVulkanStatus?.()
                    : null;
            return status?.downloaded === true && !("needsUpdate" in status && status.needsUpdate);
          })
        );
        if (!disposed && activeNotice.current === notice && repaired.every(Boolean)) {
          activeNotice.current = null;
          dismiss(notice.id);
        }
      } catch {
        // A failed status request is not evidence that the pack was repaired.
      } finally {
        checking = false;
      }
    };
    // Downloads can finish in another window; llama has no shared status event.
    const timer = setInterval(() => void checkRepaired(), 2000);
    const unsubscribe = window.electronAPI?.onWhisperGpuStatusChanged?.(() => void checkRepaired());
    void checkRepaired();
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [dismiss]);

  useEffect(() => {
    // Taking the notice clears it, so it is shown even if this effect was
    // cleaned up meanwhile (StrictMode remounts) rather than lost.
    const takeAndShow = async () => {
      const notice = await window.electronAPI?.takeGpuPackMigrationNotice?.();
      if (!notice) return;

      const inControlPanel = isControlPanelWindow();
      if (!inControlPanel) void window.electronAPI?.showDictationPanel?.();
      // The llama pack's card is under AI Models; every other pack is whisper's.
      const settingsSection = notice.packs.every((pack) => pack.endsWith("llama"))
        ? "llms"
        : "speechToText";
      const id = toast({
        title: t("app.toasts.gpuPackMigration.title"),
        description: t("app.toasts.gpuPackMigration.description", {
          packs: notice.packs.join(", "),
        }),
        actions: [
          {
            label: t("providerErrors.openSettings"),
            icon: "settings",
            dismissOnClick: false,
            onClick: async () => {
              const result = await window.electronAPI?.openSettingsSection?.(settingsSection);
              if (result?.success && activeNotice.current) {
                dismiss(activeNotice.current.id);
                activeNotice.current = null;
              }
            },
          },
        ],
        // An app started to the tray may take the notice at login, before
        // anyone is looking, so the pill keeps it until it is dismissed.
        duration: inControlPanel ? 15000 : 0,
        presentation: inControlPanel ? "standard" : "dictation-error",
        dismissible: true,
        onSettled: () => {
          if (activeNotice.current?.id === id) activeNotice.current = null;
        },
      });
      activeNotice.current = { id, packs: notice.packs };
    };

    if (isControlPanelWindow()) {
      void takeAndShow();
      return undefined;
    }
    return window.electronAPI?.onGpuPackMigrationNoticeReady?.(() => void takeAndShow());
  }, [toast, dismiss, t]);

  return null;
}
