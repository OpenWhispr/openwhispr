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

  // Generic "microphone" without external device indicators
  if (lowerLabel.includes("microphone")) {
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
    ];
    return !externalIndicators.some((indicator) => lowerLabel.includes(indicator));
  }

  return false;
}
