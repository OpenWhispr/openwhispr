import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { usePolicySnapshot } from "../hooks/usePolicy";
import { useGpuBannerAvailability } from "../hooks/useGpuBannerAvailability";
import { usePolicyStore } from "../stores/policyStore";
import { isAgentAllowed } from "../stores/policyRules";
import { selectPolicyEffectiveSettings, useSettingsStore } from "../stores/settingsStore";
import type { SettingsNavigationStore } from "../stores/settingsNavigationStore";
import { getCachedPlatform } from "../utils/platform";
import { Button } from "./ui/button";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { cn } from "./lib/utils";
import { Zap } from "./icons";

const platform = getCachedPlatform();

export function GpuAccelerationBanner({ navigation }: { navigation: SettingsNavigationStore }) {
  const { t } = useTranslation();
  const openSettings = useStore(navigation, (state) => state.openSettings);
  const settingsOpen = useStore(navigation, (state) => state.section !== null);
  const dismissed = useStore(navigation, (state) => state.gpuBannerDismissed);
  const dismiss = useStore(navigation, (state) => state.dismissGpuBanner);
  const policySnapshot = usePolicySnapshot();
  const agentAllowedByPolicy = usePolicyStore(isAgentAllowed);
  const settings = useSettingsStore(
    useShallow((settings) => {
      const effective = selectPolicyEffectiveSettings(settings, policySnapshot);
      return {
        useLocalWhisper: effective.useLocalWhisper,
        localTranscriptionProvider: effective.localTranscriptionProvider,
        useCleanupModel: effective.useCleanupModel,
        cleanupMode: effective.cleanupMode,
        useDictationAgent: effective.useDictationAgent,
        dictationAgentMode: effective.dictationAgentMode,
      };
    })
  );
  // Native availability belongs to its visible offer, not the modal host.
  const banner = useGpuBannerAvailability({
    settings,
    agentAllowedByPolicy,
    dismissed,
    settingsOpen,
    platform,
  });
  if (dismissed || (!banner.transcription && !banner.intelligence)) return null;

  return (
    <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "px-6 mb-3")}>
      <div className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/5 p-3">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center">
            <Zap size={16} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground mb-0.5">
              {t("controlPanel.gpu.bannerTitle")}
            </p>
            <p className="text-xs text-muted-foreground mb-2">
              {t("controlPanel.gpu.bannerDescription")}
            </p>
            <div className="flex items-center gap-3">
              <Button
                variant="default"
                size="sm"
                className="h-7 text-xs"
                onClick={() =>
                  openSettings(
                    banner.transcription
                      ? "transcription"
                      : banner.intelligence === "dictationAgent"
                        ? "dictationAgent"
                        : "intelligence"
                  )
                }
              >
                {t("controlPanel.gpu.enableButton")}
              </Button>
              <button
                onClick={dismiss}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("controlPanel.gpu.dismissButton")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
