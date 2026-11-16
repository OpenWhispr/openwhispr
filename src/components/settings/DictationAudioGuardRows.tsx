import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsStore } from "../../stores/settingsStore";
import type { DictationAudioDevice, DictationAudioGuardStatus } from "../../types/electron";

const DUCK_LEVELS = [0, 10, 25, 50];
const AUTO_TARGET = "auto";
const DEFAULT_SOURCE = "default";
const STATUS_POLL_MS = 3000;
const SELECT_TRIGGER = "h-7 w-44 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3";

/**
 * Windows-only Sound Effects rows for the dictation audio guard: lower other
 * apps while dictating, and keep the dictation out of calls through a virtual
 * audio device. Renders nothing where the helper isn't available.
 */
export function DictationAudioGuardRows() {
  const { t } = useTranslation();
  const settings = useSettingsStore(
    useShallow((state) => ({
      duckAudioOnDictation: state.duckAudioOnDictation,
      duckAudioPercent: state.duckAudioPercent,
      callMicGateEnabled: state.callMicGateEnabled,
      callMicGateSourceId: state.callMicGateSourceId,
      callMicGateTargetId: state.callMicGateTargetId,
      setDuckAudioOnDictation: state.setDuckAudioOnDictation,
      setDuckAudioPercent: state.setDuckAudioPercent,
      setCallMicGateEnabled: state.setCallMicGateEnabled,
      setCallMicGateSourceId: state.setCallMicGateSourceId,
      setCallMicGateTargetId: state.setCallMicGateTargetId,
    }))
  );
  const [status, setStatus] = useState<DictationAudioGuardStatus | null>(null);
  const [devices, setDevices] = useState<{
    capture: DictationAudioDevice[];
    render: DictationAudioDevice[];
  }>({ capture: [], render: [] });

  const refreshStatus = useCallback(() => {
    window.electronAPI
      ?.getDictationAudioGuardStatus?.()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus, settings.callMicGateEnabled, settings.duckAudioOnDictation]);

  useEffect(() => {
    if (!settings.callMicGateEnabled) return;
    window.electronAPI
      ?.listDictationAudioDevices?.()
      .then(setDevices)
      .catch(() => {});
    const timer = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [settings.callMicGateEnabled, refreshStatus]);

  if (!status?.supported) return null;

  const gateStatus = !settings.callMicGateEnabled
    ? null
    : status.forwarding
      ? t("settingsPage.general.soundEffects.callMicGateActive", {
          device: status.forwardTargetName ?? "",
        })
      : status.forwardError === "no-virtual-device"
        ? t("settingsPage.general.soundEffects.callMicGateNoDevice")
        : t("settingsPage.general.soundEffects.callMicGateStarting");

  return (
    <>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.general.soundEffects.duckAudio")}
          description={t("settingsPage.general.soundEffects.duckAudioDescription")}
        >
          <Toggle
            checked={settings.duckAudioOnDictation}
            onChange={settings.setDuckAudioOnDictation}
          />
        </SettingsRow>
      </SettingsPanelRow>
      {settings.duckAudioOnDictation && (
        <SettingsPanelRow>
          <SettingsRow label={t("settingsPage.general.soundEffects.duckAudioLevel")}>
            <Select
              value={String(settings.duckAudioPercent)}
              onValueChange={(value) => settings.setDuckAudioPercent(Number(value))}
            >
              <SelectTrigger className={SELECT_TRIGGER}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DUCK_LEVELS.map((level) => (
                  <SelectItem key={level} value={String(level)}>
                    {level === 0
                      ? t("settingsPage.general.soundEffects.duckAudioMuted")
                      : `${level}%`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsPanelRow>
      )}
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.general.soundEffects.callMicGate")}
          description={
            <>
              {t("settingsPage.general.soundEffects.callMicGateDescription")}
              {gateStatus && <span className="block mt-1 text-foreground/80">{gateStatus}</span>}
            </>
          }
        >
          <Toggle checked={settings.callMicGateEnabled} onChange={settings.setCallMicGateEnabled} />
        </SettingsRow>
      </SettingsPanelRow>
      {settings.callMicGateEnabled && (
        <>
          <SettingsPanelRow>
            <SettingsRow label={t("settingsPage.general.soundEffects.callMicGateSource")}>
              <Select
                value={settings.callMicGateSourceId || DEFAULT_SOURCE}
                onValueChange={settings.setCallMicGateSourceId}
              >
                <SelectTrigger className={SELECT_TRIGGER}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_SOURCE}>
                    {t("settingsPage.general.soundEffects.callMicGateDefaultMic")}
                  </SelectItem>
                  {devices.capture.map((device) => (
                    <SelectItem key={device.id} value={device.id}>
                      {device.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow label={t("settingsPage.general.soundEffects.callMicGateTarget")}>
              <Select
                value={settings.callMicGateTargetId || AUTO_TARGET}
                onValueChange={(value) =>
                  settings.setCallMicGateTargetId(value === AUTO_TARGET ? "" : value)
                }
              >
                <SelectTrigger className={SELECT_TRIGGER}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_TARGET}>
                    {t("settingsPage.general.soundEffects.callMicGateAutoTarget")}
                  </SelectItem>
                  {devices.render.map((device) => (
                    <SelectItem key={device.id} value={device.id}>
                      {device.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          </SettingsPanelRow>
        </>
      )}
    </>
  );
}
