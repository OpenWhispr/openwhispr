import { getSettings } from "../stores/settingsStore";
import logger from "../utils/logger";
import { resolveMicDeviceSelection } from "./micDeviceSelection";

/**
 * Resolve the saved mic selection against live devices, persisting a remap or
 * label backfill so the preference survives Chromium device-ID rotation.
 * `labelsAvailable` is false while device labels are hidden (no mic permission
 * yet), in which case a failed resolution should not be treated as final.
 */
export async function reconcileSavedMicSelection(
  selectedDeviceId,
  selectedDeviceLabel,
  logChannel
) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const { device, status } = resolveMicDeviceSelection(
    devices,
    selectedDeviceId,
    selectedDeviceLabel
  );

  if (!device) {
    return {
      deviceId: selectedDeviceId,
      resolved: false,
      labelsAvailable: devices.some((d) => d.kind === "audioinput" && d.label),
    };
  }

  if (status === "remapped" || (!selectedDeviceLabel && device.label)) {
    getSettings().setSelectedMicDevice(device.deviceId, device.label);
    logger.info(
      status === "remapped"
        ? "Restored selected microphone after its device ID changed"
        : "Saved selected microphone label for future recovery",
      { deviceId: device.deviceId, label: device.label },
      logChannel
    );
  }

  return { deviceId: device.deviceId, resolved: true, labelsAvailable: true };
}
