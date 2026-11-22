import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fourierPreferenceKey } from "../../helpers/fourierPilotSelection";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";

export function FourierPilotOption({ account }: { account: string }) {
  const { t } = useTranslation();
  const [option, setOption] = useState<{ account: string; key: string; enabled: boolean } | null>(
    null
  );
  useEffect(() => {
    let current = true;
    window.electronAPI
      .getSttConfig?.()
      .then((config) => {
        const key = fourierPreferenceKey(config);
        if (current && key && config?.optionalBatchModelAccount === account)
          setOption({ account, key, enabled: localStorage.getItem(key) === "1" });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [account]);
  if (!option || option.account !== account) return null;
  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <SettingsRow
          label="Fourier 2B"
          description={t("settingsPage.transcription.fourierEnglishPilot")}
        >
          <Toggle
            ariaLabel="Fourier 2B"
            checked={option.enabled}
            onChange={(enabled) => {
              if (enabled) localStorage.setItem(option.key, "1");
              else localStorage.removeItem(option.key);
              setOption({ ...option, enabled });
            }}
          />
        </SettingsRow>
      </SettingsPanelRow>
    </SettingsPanel>
  );
}
