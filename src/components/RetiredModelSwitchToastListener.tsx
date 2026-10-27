import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import type { RetiredModelProvider } from "../config/retiredCloudModels";
import {
  consumeRetiredModelSwitches,
  useRetiredModelSwitchStore,
} from "../stores/retiredModelSwitchStore";
import { isDictationPanelWindow } from "../utils/windowContext";

const RETIRED_MESSAGE_KEYS: Record<RetiredModelProvider, string> = {
  groq: "reasoning.groq.modelRetired",
  tinfoil: "reasoning.tinfoil.modelRetired",
};

/** Alerts the user when a retired cloud model was switched out from under them. */
export default function RetiredModelSwitchToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const switchCount = useRetiredModelSwitchStore((s) => s.events.length);

  useEffect(() => {
    if (switchCount === 0) return;
    // The panel may already be hidden after dictation; surface it so the toast is seen.
    if (isDictationPanelWindow()) {
      window.electronAPI?.showDictationPanel?.();
    }
    for (const event of consumeRetiredModelSwitches()) {
      toast({
        title: t("reasoning.modelRetiredTitle"),
        description: t(RETIRED_MESSAGE_KEYS[event.provider], { from: event.from, to: event.to }),
      });
    }
  }, [switchCount, toast, t]);

  return null;
}
