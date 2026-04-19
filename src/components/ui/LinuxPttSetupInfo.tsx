import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { InfoBox } from "./InfoBox";
import { CopyableCommand } from "./CopyableCommand";

interface LinuxPttSetupInfoProps {
  isAvailable: boolean;
}

export default function LinuxPttSetupInfo({ isAvailable }: LinuxPttSetupInfoProps) {
  const { t } = useTranslation();

  if (isAvailable) {
    return null;
  }

  return (
    <InfoBox variant="warning" className="mt-3">
      <div className="flex items-start gap-3">
        <Info className="w-6 h-6 text-warning dark:text-warning flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold text-warning dark:text-warning">
            {t("settingsPage.general.hotkey.linuxPttSetupTitle")}
          </h3>
          <p className="text-sm text-warning dark:text-warning mt-1">
            {t("settingsPage.general.hotkey.linuxPttSetupDescription")}
          </p>
          <CopyableCommand command="sudo usermod -aG input $USER" className="mt-3" />
          <p className="text-sm text-warning dark:text-warning mt-3">
            {t("settingsPage.general.hotkey.linuxPttSetupNote")}
          </p>
        </div>
      </div>
    </InfoBox>
  );
}
