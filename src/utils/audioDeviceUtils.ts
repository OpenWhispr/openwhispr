/**
 * Utility functions for audio device detection and management.
 * Shared between renderer components and audio manager.
 */

/**
 * Determines if a microphone device is a built-in device based on its label.
 * Works across macOS, Windows, and Linux platforms.
 */
export function isBuiltInMicrophone(label: string): boolean {
  const lowerLabel = label.toLowerCase();

  // Direct built-in indicators
  if (
    lowerLabel.includes("built-in") ||
    lowerLabel.includes("internal") ||
    lowerLabel.includes("macbook") ||
    lowerLabel.includes("integrated")
  ) {
    return true;
  }

  // Generic "microphone" without external device indicators. Indicators are
  // matched against the label with the word "microphone" removed — "phone"
  // must flag "iPhone"/"Cell Phone"/"Headphones" without matching the "phone"
  // inside "microphone" itself.
  if (lowerLabel.includes("microphone")) {
    const labelWithoutMicrophone = lowerLabel.replace(/microphone/g, " ");
    const externalIndicators = [
      "bluetooth",
      "airpods",
      "wireless",
      "usb",
      "external",
      "headset",
      "webcam",
      "iphone",
      "ipad",
      // Phones connected to the computer (Continuity, Bluetooth) carry the
      // device's own name (e.g. "Galaxy Cell Microphone" from a field report) —
      // nothing above matched, so one was classified built-in, auto-selected,
      // and cached; dictations then streamed distant phone-mic audio and
      // transcribed as empty. "phone" also matches
      // "headphones", which is fine: a headphone mic is external too, and the
      // harmful direction is only external-classified-as-built-in.
      "cell",
      "phone",
      "continuity",
    ];
    return !externalIndicators.some((indicator) => labelWithoutMicrophone.includes(indicator));
  }

  return false;
}
