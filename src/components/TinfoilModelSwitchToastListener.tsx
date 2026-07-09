import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import {
  consumeTinfoilModelSwitches,
  useTinfoilModelSwitchStore,
} from "../stores/tinfoilModelSwitchStore";

/**
 * Tinfoils models are a bit ephemeral, alert user if one switches out from under them
 */
export default function TinfoilModelSwitchToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const switchCount = useTinfoilModelSwitchStore((s) => s.events.length);

  useEffect(() => {
    if (switchCount === 0) return;
    for (const event of consumeTinfoilModelSwitches()) {
      toast({
        title: t("reasoning.tinfoil.modelRetiredTitle"),
        description: t("reasoning.tinfoil.modelRetired", { from: event.from, to: event.to }),
      });
    }
  }, [switchCount, toast, t]);

  return null;
}
