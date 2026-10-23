export type Platform = "darwin" | "win32" | "linux";

/**
 * Detects the current platform using Electron when available,
 * falling back to user agent detection.
 */
export function getPlatform(): Platform {
  // Try Electron API first
  if (typeof window !== "undefined" && window.electronAPI?.getPlatform) {
    const platform = window.electronAPI.getPlatform();
    if (platform === "darwin" || platform === "win32" || platform === "linux") {
      return platform;
    }
  }

  // Fallback to user agent detection
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "darwin";
    if (ua.includes("win")) return "win32";
    if (ua.includes("linux")) return "linux";
  }

  // Default to darwin
  return "darwin";
}

/**
 * Cached platform value for performance
 */
let cachedPlatform: Platform | null = null;

export function getCachedPlatform(): Platform {
  if (cachedPlatform === null) {
    cachedPlatform = getPlatform();
  }
  return cachedPlatform;
}

/** The label for revealing a file or folder in the system's file manager. */
export function showInFolderLabelKey(platform: Platform): string {
  if (platform === "win32") return "controlPanel.history.showInFolderWindows";
  if (platform === "linux") return "controlPanel.history.showInFolderLinux";
  return "controlPanel.history.showInFolder";
}
