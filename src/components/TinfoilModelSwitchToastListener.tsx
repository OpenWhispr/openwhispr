import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import {
  consumeTinfoilModelSwitches,
  useTinfoilModelSwitchStore,
} from "../stores/tinfoilModelSwitchStore";

const isDictationPanelWindow = () => {
  const { search, pathname } = window.location;
  return !pathname.includes("control") && !search.includes("panel=true");
};

/** Alerts the user when a retired Tinfoil model was switched out from under them. */
export default function TinfoilModelSwitchToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const switchCount = useTinfoilModelSwitchStore((s) => s.events.length);

  useEffect(() => {
    if (switchCount === 0) return;
    // The panel may already be hidden after dictation; surface it so the toast is seen.
    if (isDictationPanelWindow()) {
      window.electronAPI?.showDictationPanel?.();
    }
    for (const event of consumeTinfoilModelSwitches()) {
      toast({
        title: t("reasoning.tinfoil.modelRetiredTitle"),
        description: t("reasoning.tinfoil.modelRetired", { from: event.from, to: event.to }),
      });
    }
  }, [switchCount, toast, t]);

  return null;
}
