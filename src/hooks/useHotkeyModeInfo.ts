import { useEffect, useState } from "react";
import logger from "../utils/logger";

export interface HyprlandConfigStatus {
  canWrite: boolean;
  path: string;
}

export interface HotkeyModeInfo {
  isUsingNativeShortcut: boolean;
  isUsingHyprland: boolean;
  supportsPushToTalk: boolean;
  hyprlandConfigStatus: HyprlandConfigStatus | null;
}

const DEFAULT_INFO: HotkeyModeInfo = {
  isUsingNativeShortcut: false,
  isUsingHyprland: false,
  supportsPushToTalk: true,
  hyprlandConfigStatus: null,
};

/**
 * Resolves how the dictation hotkey is registered for the current session
 * (native shortcut, Hyprland) and, on Hyprland, whether its config is
 * persistable. `scope` tags log output for the calling surface.
 */
export function useHotkeyModeInfo(scope: string): HotkeyModeInfo {
  const [modeInfo, setModeInfo] = useState<HotkeyModeInfo>(DEFAULT_INFO);

  useEffect(() => {
    let cancelled = false;
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo?.();
        if (!info || cancelled) return;
        const hyprlandConfigStatus = info.isUsingHyprland
          ? ((await window.electronAPI?.getHyprlandConfigStatus?.()) ?? null)
          : null;
        if (cancelled) return;
        setModeInfo({
          isUsingNativeShortcut: info.isUsingNativeShortcut,
          isUsingHyprland: info.isUsingHyprland,
          supportsPushToTalk: info.supportsPushToTalk,
          hyprlandConfigStatus,
        });
      } catch (error) {
        logger.error("Failed to check hotkey mode", { error }, scope);
      }
    };
    checkHotkeyMode();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return modeInfo;
}
