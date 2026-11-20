import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "./SettingsSection";
import { Button } from "./button";
import { RefreshCw, Mic } from "../icons";
import { isBuiltInMicrophone } from "../../utils/audioDeviceUtils";
import { resolveSystemDefaultMicDevice } from "../../helpers/microphoneSelection";
import { resolveMicDeviceSelection } from "../../helpers/micDeviceSelection";
import { MIC_WARM_HOLD_CHOICES } from "../../stores/settingsStore";

const SELECT_CLASS =
  "h-10 rounded-xl border border-border bg-surface-1 px-3.5 py-2 text-sm text-foreground focus:outline-none focus:ring-[3px] focus:ring-primary/15 focus:border-primary dark:border-border-subtle disabled:cursor-not-allowed disabled:opacity-50";

interface AudioDevice {
  kind: "audioinput";
  deviceId: string;
  label: string;
  isBuiltIn: boolean;
}

interface MicrophoneSettingsProps {
  microphoneSelectionMode: "system" | "built-in" | "specific";
  selectedMicDeviceId: string;
  selectedMicDeviceLabel: string;
  micWarmHoldSeconds: number;
  onSelectionModeChange: (mode: "system" | "built-in" | "specific") => void;
  onDeviceSelect: (deviceId: string, label: string) => void;
  onMicWarmHoldSecondsChange: (seconds: number) => void;
}

export const MicrophoneSettings: React.FC<MicrophoneSettingsProps> = ({
  microphoneSelectionMode,
  selectedMicDeviceId,
  selectedMicDeviceLabel,
  micWarmHoldSeconds,
  onSelectionModeChange,
  onDeviceSelect,
  onMicWarmHoldSecondsChange,
}) => {
  const { t } = useTranslation();
  const inputLabelId = React.useId();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [systemDefaultLabel, setSystemDefaultLabel] = useState("");
  const loadRequest = useRef(0);

  const loadDevices = useCallback(async () => {
    const request = ++loadRequest.current;
    setIsLoading(true);
    setError(null);

    try {
      // Acquiring the mic just to read labels interrupts other audio (pauses
      // music on macOS), so only do it when labels are missing (no permission yet).
      let allDevices = await navigator.mediaDevices.enumerateDevices();
      if (request !== loadRequest.current) return;
      const hasLabels = allDevices.some((d) => d.kind === "audioinput" && d.label);
      if (!hasLabels) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        if (request !== loadRequest.current) return;
        allDevices = await navigator.mediaDevices.enumerateDevices();
      }

      const audioInputs = allDevices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          kind: "audioinput" as const,
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          isBuiltIn: isBuiltInMicrophone(d.label),
        }));

      if (request !== loadRequest.current) return;
      setDevices(audioInputs);
      const nativeDefault = await window.electronAPI?.getSystemDefaultMicrophone?.();
      if (request !== loadRequest.current) return;
      const resolvedDefault = resolveSystemDefaultMicDevice(audioInputs, nativeDefault);
      setSystemDefaultLabel(nativeDefault?.name || resolvedDefault.device?.label || "");
      const resolvedSelection = resolveMicDeviceSelection(
        audioInputs,
        selectedMicDeviceId,
        selectedMicDeviceLabel
      );
      if (
        resolvedSelection.device &&
        (resolvedSelection.status === "remapped" || !selectedMicDeviceLabel)
      ) {
        onDeviceSelect(resolvedSelection.device.deviceId, resolvedSelection.device.label);
      }
    } catch {
      if (request === loadRequest.current) setError(t("microphoneSettings.errors.unableToAccess"));
    } finally {
      if (request === loadRequest.current) setIsLoading(false);
    }
  }, [onDeviceSelect, selectedMicDeviceId, selectedMicDeviceLabel, t]);

  useEffect(() => {
    loadDevices();

    const handleDeviceChange = () => loadDevices();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    const requests = loadRequest;
    return () => {
      requests.current++;
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [loadDevices]);

  const builtInDevice = devices.find((d) => d.isBuiltIn);
  const selectedDevice = devices.find((d) => d.deviceId === selectedMicDeviceId);
  const selectableDevices = devices.filter((device) => device.deviceId !== "default");
  const selectorValue =
    microphoneSelectionMode === "system"
      ? "__system__"
      : microphoneSelectionMode === "built-in"
        ? "__built-in__"
        : selectedMicDeviceId || "__specific__";

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span id={inputLabelId} className="text-sm font-medium text-foreground">
            {t("microphoneSettings.inputDevice")}
          </span>
          <Button
            aria-label={t("common.refresh")}
            variant="ghost"
            size="icon"
            onClick={loadDevices}
            disabled={isLoading}
            className="size-7"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <select
            aria-labelledby={inputLabelId}
            className={`${SELECT_CLASS} w-full`}
            value={selectorValue}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "__system__") {
                onSelectionModeChange("system");
                return;
              }
              if (value === "__built-in__") {
                onSelectionModeChange("built-in");
                return;
              }
              const device = devices.find((candidate) => candidate.deviceId === value);
              if (!device) return;
              onDeviceSelect(value, device.label);
              onSelectionModeChange("specific");
            }}
          >
            <option value="__system__">
              {`${t("microphoneSettings.systemDefault")}${systemDefaultLabel ? ` — ${systemDefaultLabel}` : ""}`}
            </option>
            <option value="__built-in__">{t("microphoneSettings.preferBuiltIn.label")}</option>
            {microphoneSelectionMode === "specific" &&
              !selectableDevices.some((device) => device.deviceId === selectorValue) && (
                <option value={selectorValue} disabled>
                  {selectedDevice?.label || t("microphoneSettings.unknownDevice")}
                </option>
              )}
            {selectableDevices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
                {device.isBuiltIn ? ` (${t("microphoneSettings.builtIn")})` : ""}
              </option>
            ))}
          </select>
        )}

        <p className="text-xs text-muted-foreground">{t("microphoneSettings.helpText")}</p>
      </div>

      {microphoneSelectionMode === "built-in" && builtInDevice && (
        <div className="p-3 bg-success/10 dark:bg-success/20 border border-success/30 rounded-lg">
          <div className="flex items-center gap-2">
            <Mic className="w-4 h-4 text-success dark:text-success" />
            <span className="text-sm text-success dark:text-success">
              {t("microphoneSettings.using", { device: builtInDevice.label })}
            </span>
          </div>
        </div>
      )}

      {microphoneSelectionMode === "built-in" && !builtInDevice && devices.length > 0 && (
        <div className="p-3 bg-warning/10 dark:bg-warning/20 border border-warning/30 rounded-lg">
          <p className="text-sm text-warning dark:text-warning">
            {t("microphoneSettings.noBuiltInDetected")}
          </p>
        </div>
      )}

      <SettingsRow
        label={t("microphoneSettings.warmHold.label")}
        description={t("microphoneSettings.warmHold.description")}
      >
        <select
          className={`${SELECT_CLASS} w-40`}
          aria-label={t("microphoneSettings.warmHold.label")}
          value={micWarmHoldSeconds}
          onChange={(event) => onMicWarmHoldSecondsChange(Number(event.target.value))}
        >
          {MIC_WARM_HOLD_CHOICES.map((seconds) => (
            <option key={seconds} value={seconds}>
              {t(`microphoneSettings.warmHold.options.${seconds}`)}
            </option>
          ))}
        </select>
      </SettingsRow>
      {micWarmHoldSeconds > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("microphoneSettings.warmHold.privacyNote")}
        </p>
      )}
    </div>
  );
};

export default MicrophoneSettings;
