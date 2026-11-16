import { useEffect } from "react";
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
  const { toast } = useToast();

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
      toast({
        title: t("app.toasts.gpuPackMigration.title"),
        description: t("app.toasts.gpuPackMigration.description", {
          packs: notice.packs.join(", "),
        }),
        actions: [
          {
            label: t("providerErrors.openSettings"),
            icon: "settings",
            onClick: () => {
              void window.electronAPI?.openSettingsSection?.(settingsSection);
            },
          },
        ],
        // An app started to the tray may take the notice at login, before
        // anyone is looking, so the pill keeps it until it is dismissed.
        duration: inControlPanel ? 15000 : 0,
      });
    };

    if (isControlPanelWindow()) {
      void takeAndShow();
      return undefined;
    }
    return window.electronAPI?.onGpuPackMigrationNoticeReady?.(() => void takeAndShow());
  }, [toast, t]);

  return null;
}
