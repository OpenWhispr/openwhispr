import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import { isDictationPanelWindow } from "../utils/windowContext";

/**
 * One-time notice that a GPU pack was cleared or needs re-downloading, which
 * otherwise degrades to a silent CPU fallback. The notice is persisted by the
 * main process (it happens before any window exists) and cleared once shown.
 * Surfaces on the control panel if visible, or on the dictation panel for
 * users running minimized (#1606, #2554).
 */
export default function GpuPackMigrationToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;

    const showNotice = async () => {
      if (isDictationPanelWindow()) {
        // Give the control panel time to open on cold start if not start-minimized
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (cancelled) return;

        const isControlPanelOpen = await window.electronAPI?.isControlPanelVisible?.();
        if (cancelled || isControlPanelOpen) return;
      }

      const notice = await window.electronAPI?.getGpuPackMigrationNotice?.();
      if (cancelled || !notice) return;

      if (isDictationPanelWindow()) {
        window.electronAPI?.showDictationPanel?.();
      }

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
              void window.electronAPI?.openSettingsSection?.("speechToText");
            },
          },
        ],
        duration: 15000,
      });

      await window.electronAPI?.dismissGpuPackMigrationNotice?.();
    };

    void showNotice();

    return () => {
      cancelled = true;
    };
  }, [toast, t]);

  return null;
}
