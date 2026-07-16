import { useTranslation } from "react-i18next";
import { Check, Settings } from "lucide-react";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";

interface FinishStepProps {
  isCloudUser: boolean;
  useCases: string[];
  onFinish: (openSettings: boolean) => void;
  isFinishing: boolean;
  autoStartEnabled: boolean;
  onAutoStartChange: (value: boolean) => void;
  startMinimized: boolean;
  onStartMinimizedChange: (value: boolean) => void;
}

export default function FinishStep({
  isCloudUser,
  onFinish,
  isFinishing,
  autoStartEnabled,
  onAutoStartChange,
  startMinimized,
  onStartMinimizedChange,
}: FinishStepProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="text-center space-y-0.5">
        <div className="w-12 h-12 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-3">
          <Check className="w-6 h-6 text-green-500" />
        </div>
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.finish.title")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {isCloudUser
            ? t("onboarding.finish.cloudDescription")
            : t("onboarding.finish.localDescription")}
        </p>
      </div>

      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("onboarding.finish.autoStart")}
            description={t("onboarding.finish.autoStartDescription")}
          >
            <Toggle checked={autoStartEnabled} onChange={onAutoStartChange} />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label={t("onboarding.finish.startMinimized")}
            description={t("onboarding.finish.startMinimizedDescription")}
          >
            <Toggle checked={startMinimized} onChange={onStartMinimizedChange} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      <p className="text-xs text-muted-foreground text-center">
        {t("onboarding.finish.cleanupNote")}
      </p>

      <div className="flex items-center justify-center gap-2">
        <Button
          variant="outline"
          onClick={() => onFinish(true)}
          disabled={isFinishing}
          className="h-8 px-5 rounded-full text-xs"
        >
          <Settings className="w-3.5 h-3.5" />
          {t("onboarding.finish.openSettings")}
        </Button>
        <Button
          variant="success"
          onClick={() => onFinish(false)}
          disabled={isFinishing}
          className="h-8 px-6 rounded-full text-xs"
        >
          <Check className="w-3.5 h-3.5" />
          {t("onboarding.finish.skipForNow")}
        </Button>
      </div>
    </div>
  );
}
