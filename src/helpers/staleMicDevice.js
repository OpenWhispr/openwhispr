// Detects the OverconstrainedError getUserMedia throws when a saved deviceId no
// longer matches any device. Chromium rotates mediaDevices IDs over time, so a
// pinned { deviceId: { exact } } eventually goes stale and recording fails. See #900.
export function isStaleDeviceError(error) {
  if (!error || error.name !== "OverconstrainedError") return false;
  // deviceId is the only constraint pinned with { exact }; treat an unknown/empty
  // constraint as the device too, but skip a known non-deviceId constraint.
  const constraint = error.constraint;
  return !constraint || constraint === "deviceId";
}
