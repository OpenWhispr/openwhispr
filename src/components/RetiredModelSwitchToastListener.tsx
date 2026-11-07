import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import type { RetiredModelProvider } from "../config/retiredCloudModels";
import {
  consumeRetiredModelSwitches,
  QUEUED_SWITCHES_KEY,
  takeQueuedRetiredModelSwitches,
  useRetiredModelSwitchStore,
  type RetiredModelSwitch,
} from "../stores/retiredModelSwitchStore";
import { isControlPanelWindow, isDictationPanelWindow } from "../utils/windowContext";

const RETIRED_MESSAGE_KEYS: Partial<Record<string, string>> & Record<RetiredModelProvider, string> =
  {
    groq: "reasoning.groq.modelRetired",
    tinfoil: "reasoning.tinfoil.modelRetired",
    openai: "reasoning.openai.modelRetired",
    "opencode-go": "reasoning.opencode.modelRetired",
    "opencode-zen": "reasoning.opencode.modelRetired",
  };

/** Alerts the user when a retired cloud model was switched out from under them. */
export default function RetiredModelSwitchToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const switchCount = useRetiredModelSwitchStore((s) => s.events.length);

  const show = useCallback(
    (event: RetiredModelSwitch) =>
      toast({
        title: t("reasoning.modelRetiredTitle"),
        description: t(
          event.messageKey ??
            RETIRED_MESSAGE_KEYS[event.provider] ??
            "reasoning.modelRetiredByProvider",
          {
            provider: event.providerName ?? event.provider,
            from: event.from,
            to: event.to,
          }
        ),
      }),
    [toast, t]
  );

  useEffect(() => {
    if (switchCount === 0) return;
    // The panel may already be hidden after dictation; surface it so the toast is seen.
    if (isDictationPanelWindow()) {
      window.electronAPI?.showDictationPanel?.();
    }
    consumeRetiredModelSwitches().forEach(show);
  }, [switchCount, show]);

  // Catalog changes wait for the control panel. backgroundThrottling is off, so a panel in
  // the tray still reports itself visible; it has no focus there, though.
  useEffect(() => {
    if (!isControlPanelWindow()) return;
    const deliver = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      takeQueuedRetiredModelSwitches().forEach(show);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === QUEUED_SWITCHES_KEY && event.newValue) deliver();
    };
    deliver();
    document.addEventListener("visibilitychange", deliver);
    window.addEventListener("focus", deliver);
    window.addEventListener("storage", onStorage);
    const unsubscribe = useRetiredModelSwitchStore.subscribe(deliver);
    return () => {
      document.removeEventListener("visibilitychange", deliver);
      window.removeEventListener("focus", deliver);
      window.removeEventListener("storage", onStorage);
      unsubscribe();
    };
  }, [show]);

  return null;
}
