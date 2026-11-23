import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { STT_EXPERIMENT_CONFIG_TTL_MS } from "../../helpers/dictationStreamingRouting";
import { fourierPreferenceKey } from "../../helpers/fourierPilotSelection";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { usePanelVisible } from "../ui/usePanelVisible";
import { Toggle } from "../ui/toggle";

export function FourierPilotOption({ account }: { account: string }): React.JSX.Element | null {
  const { t } = useTranslation();
  const visible = usePanelVisible();
  const [option, setOption] = useState<{ account: string; key: string; enabled: boolean } | null>(
    null
  );
  useEffect(() => {
    if (!visible) return;
    let current = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;

    const refresh = async (): Promise<void> => {
      if (document.hidden || pending || !window.electronAPI.getSttConfig) return;
      clearTimeout(timer);
      pending = true;
      const config = await window.electronAPI.getSttConfig().catch(() => null);
      pending = false;
      if (!current) return;

      const key =
        config?.optionalBatchModelAccount === account ? fourierPreferenceKey(config) : null;
      setOption(key ? { account, key, enabled: localStorage.getItem(key) === "1" } : null);
      // Recheck an advertised pilot or retry a failed lookup. Other accounts need no polling.
      if (key || !config?.success) timer = setTimeout(refresh, STT_EXPERIMENT_CONFIG_TTL_MS);
    };

    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [account, visible]);
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
