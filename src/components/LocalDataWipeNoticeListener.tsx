import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import { isControlPanelWindow } from "../utils/windowContext";

/**
 * Tells the person a removal from their organization's workspace wiped this
 * device (#3030). The wipe ran before any window existed and relaunched the
 * app as a fresh install; main keeps the notice until the control panel takes
 * it, and the toast stays until it is dismissed.
 */
export default function LocalDataWipeNoticeListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  useEffect(() => {
    if (!isControlPanelWindow()) return;
    void window.electronAPI?.takeLocalDataWipeNotice?.().then((notice) => {
      if (notice !== "workspace-removal") return;
      toast({
        title: t("app.toasts.localDataWiped.title"),
        description: t("app.toasts.localDataWiped.description"),
        duration: 0,
      });
    });
  }, [toast, t]);

  return null;
}
