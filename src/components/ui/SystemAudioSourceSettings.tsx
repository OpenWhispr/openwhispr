import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "./SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import {
  SYSTEM_AUDIO_SOURCE_ALL_DEVICES,
  SYSTEM_AUDIO_SOURCE_DEFAULT_DEVICE,
  normalizeSystemAudioSource,
} from "../../helpers/systemAudioSource";
import { getDefaultPlaybackDeviceName } from "../../utils/systemAudioAccess";
import type { SystemAudioSource } from "../../types/electron";
import type { Platform } from "../../utils/platform";

interface SystemAudioSourceSettingsProps {
  platform: Platform;
  systemAudioSource: SystemAudioSource;
  onSystemAudioSourceChange: (source: SystemAudioSource) => void;
}

// Windows only (#1546). The native helper records every playback device,
// including virtual ones (voice changers, audio cables) that can carry the
// user's own voice. The opt-in records only the Windows default output through
// Chromium's loopback. macOS and Linux capture differently and offer no choice,
// so the whole section is absent there.
export const SystemAudioSourceSettings: React.FC<SystemAudioSourceSettingsProps> = ({
  platform,
  systemAudioSource,
  onSystemAudioSourceChange,
}) => {
  const { t } = useTranslation();
  const isWindows = platform === "win32";
  const [defaultDeviceName, setDefaultDeviceName] = useState("");

  useEffect(() => {
    if (!isWindows) return undefined;
    let active = true;
    const loadDefaultDeviceName = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (active) setDefaultDeviceName(getDefaultPlaybackDeviceName(devices));
      } catch {
        if (active) setDefaultDeviceName("");
      }
    };
    void loadDefaultDeviceName();
    navigator.mediaDevices.addEventListener("devicechange", loadDefaultDeviceName);
    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener("devicechange", loadDefaultDeviceName);
    };
  }, [isWindows]);

  if (!isWindows) return null;

  const source = normalizeSystemAudioSource(systemAudioSource);
  const isDefaultDevice = source === SYSTEM_AUDIO_SOURCE_DEFAULT_DEVICE;
  const allDevicesLabel = t("systemAudioSourceSettings.allDevices");
  const defaultDeviceLabel = t("systemAudioSourceSettings.defaultDevice");
  const defaultDeviceOption = defaultDeviceName
    ? `${defaultDeviceLabel} — ${defaultDeviceName}`
    : defaultDeviceLabel;

  return (
    <div>
      <SectionHeader
        title={t("systemAudioSourceSettings.title")}
        description={t("systemAudioSourceSettings.description")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <div className="space-y-3">
            <label htmlFor="system-audio-source" className="text-sm font-medium text-foreground">
              {t("systemAudioSourceSettings.label")}
            </label>
            <Select
              value={source}
              onValueChange={(value) =>
                onSystemAudioSourceChange(normalizeSystemAudioSource(value))
              }
            >
              <SelectTrigger id="system-audio-source" className="w-full">
                <SelectValue>{isDefaultDevice ? defaultDeviceOption : allDevicesLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SYSTEM_AUDIO_SOURCE_ALL_DEVICES}>{allDevicesLabel}</SelectItem>
                <SelectItem value={SYSTEM_AUDIO_SOURCE_DEFAULT_DEVICE}>
                  {defaultDeviceOption}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {isDefaultDevice
                ? t("systemAudioSourceSettings.defaultDeviceHelp")
                : t("systemAudioSourceSettings.allDevicesHelp")}
            </p>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
};

export default SystemAudioSourceSettings;
