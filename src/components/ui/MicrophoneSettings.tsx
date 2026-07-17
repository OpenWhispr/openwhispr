import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Toggle } from "./toggle";
import { SettingsRow } from "./SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Button } from "./button";
import { RefreshCw, Mic } from "lucide-react";
import { isBuiltInMicrophone } from "../../utils/audioDeviceUtils";
import { resolveMicDeviceSelection } from "../../helpers/micDeviceSelection";

interface AudioDevice {
  deviceId: string;
  label: string;
  isBuiltIn: boolean;
}

interface MicrophoneSettingsProps {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  selectedMicDeviceLabel: string;
  onPreferBuiltInChange: (value: boolean) => void;
  onDeviceSelect: (deviceId: string, label: string) => void;
}

export const MicrophoneSettings: React.FC<MicrophoneSettingsProps> = ({
  preferBuiltInMic,
  selectedMicDeviceId,
  selectedMicDeviceLabel,
  onPreferBuiltInChange,
  onDeviceSelect,
}) => {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use refs to access current values without triggering re-renders
  const preferBuiltInRef = useRef(preferBuiltInMic);
  const selectedDeviceRef = useRef(selectedMicDeviceId);
  const selectedDeviceLabelRef = useRef(selectedMicDeviceLabel);
  const onDeviceSelectRef = useRef(onDeviceSelect);

  // Keep refs in sync
  useEffect(() => {
    preferBuiltInRef.current = preferBuiltInMic;
    selectedDeviceRef.current = selectedMicDeviceId;
    selectedDeviceLabelRef.current = selectedMicDeviceLabel;
    onDeviceSelectRef.current = onDeviceSelect;
  }, [preferBuiltInMic, selectedMicDeviceId, selectedMicDeviceLabel, onDeviceSelect]);

  const loadDevices = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Acquiring the mic just to read labels interrupts other audio (pauses
      // music on macOS), so only do it when labels are missing (no permission yet).
      let allDevices = await navigator.mediaDevices.enumerateDevices();
      const hasLabels = allDevices.some((d) => d.kind === "audioinput" && d.label);
      if (!hasLabels) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        allDevices = await navigator.mediaDevices.enumerateDevices();
      }

      const audioInputs = allDevices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          isBuiltIn: isBuiltInMicrophone(d.label),
        }));

      setDevices(audioInputs);

      const resolvedSelection = resolveMicDeviceSelection(
        audioInputs,
        selectedDeviceRef.current,
        selectedDeviceLabelRef.current
      );
      if (
        resolvedSelection.device &&
        (resolvedSelection.status === "remapped" || !selectedDeviceLabelRef.current)
      ) {
        onDeviceSelectRef.current(
          resolvedSelection.device.deviceId,
          resolvedSelection.device.label
        );
      }

      // If no device is selected and not preferring built-in, select the first device
      if (!preferBuiltInRef.current && !selectedDeviceRef.current && audioInputs.length > 0) {
        onDeviceSelectRef.current(audioInputs[0].deviceId, audioInputs[0].label);
      }
    } catch {
      setError(t("microphoneSettings.errors.unableToAccess"));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadDevices();

    const handleDeviceChange = () => loadDevices();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [loadDevices]);

  const builtInDevice = devices.find((d) => d.isBuiltIn);
  const selectedDevice = devices.find((d) => d.deviceId === selectedMicDeviceId);

  return (
    <div className="space-y-4">
      <SettingsRow
        label={t("microphoneSettings.preferBuiltIn.label")}
        description={t("microphoneSettings.preferBuiltIn.description")}
      >
        <Toggle checked={preferBuiltInMic} onChange={onPreferBuiltInChange} />
      </SettingsRow>

      {preferBuiltInMic && builtInDevice && (
        <div className="p-3 bg-success/10 dark:bg-success/20 border border-success/30 rounded-lg">
          <div className="flex items-center gap-2">
            <Mic className="w-4 h-4 text-success dark:text-success" />
            <span className="text-sm text-success dark:text-success">
              {t("microphoneSettings.using", { device: builtInDevice.label })}
            </span>
          </div>
        </div>
      )}

      {preferBuiltInMic && !builtInDevice && devices.length > 0 && (
        <div className="p-3 bg-warning/10 dark:bg-warning/20 border border-warning/30 rounded-lg">
          <p className="text-sm text-warning dark:text-warning">
            {t("microphoneSettings.noBuiltInDetected")}
          </p>
        </div>
      )}

      {!preferBuiltInMic && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-foreground">
              {t("microphoneSettings.inputDevice")}
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={loadDevices}
              disabled={isLoading}
              className="h-7 w-7 p-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <Select
              value={selectedMicDeviceId || "default"}
              onValueChange={(value) => {
                if (value === "default") {
                  onDeviceSelect("", "");
                  return;
                }
                const device = devices.find((candidate) => candidate.deviceId === value);
                onDeviceSelect(value, device?.label || "");
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("microphoneSettings.selectPlaceholder")}>
                  {selectedMicDeviceId
                    ? selectedDevice?.label || t("microphoneSettings.unknownDevice")
                    : t("microphoneSettings.systemDefault")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("microphoneSettings.systemDefault")}</SelectItem>
                {devices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label}
                    {device.isBuiltIn && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t("microphoneSettings.builtIn")}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <p className="text-xs text-muted-foreground">{t("microphoneSettings.helpText")}</p>
        </div>
      )}
    </div>
  );
};

export default MicrophoneSettings;
