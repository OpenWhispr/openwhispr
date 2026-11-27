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
  pushToTalkUnavailableReason: string | null;
  doubleTapUnavailableReason: string | null;
  /** Linux only: the evdev listener cannot read /dev/input, which Hold needs. */
  linuxInputAccessDenied: boolean;
  hyprlandConfigStatus: HyprlandConfigStatus | null;
  /** False until main has answered; the defaults above are optimistic placeholders. */
  loaded: boolean;
}

const DEFAULT_INFO: HotkeyModeInfo = {
  isUsingNativeShortcut: false,
  isUsingHyprland: false,
  supportsPushToTalk: true,
  pushToTalkUnavailableReason: null,
  doubleTapUnavailableReason: null,
  linuxInputAccessDenied: false,
  hyprlandConfigStatus: null,
  loaded: false,
};

/**
 * Resolves how the dictation hotkey is registered for the current session
 * (native shortcut, Hyprland) and, on Hyprland, whether its config is
 * persistable. `scope` tags log output for the calling surface.
 */
export function useHotkeyModeInfo(scope: string, hotkey?: string): HotkeyModeInfo {
  const [modeInfo, setModeInfo] = useState<HotkeyModeInfo>(DEFAULT_INFO);

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    const checkHotkeyMode = async () => {
      const request = ++requestId;
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo?.(hotkey);
        if (!info || cancelled || request !== requestId) return;
        const hyprlandConfigStatus = info.isUsingHyprland
          ? ((await window.electronAPI?.getHyprlandConfigStatus?.()) ?? null)
          : null;
        if (cancelled || request !== requestId) return;
        setModeInfo({
          isUsingNativeShortcut: info.isUsingNativeShortcut,
          isUsingHyprland: info.isUsingHyprland,
          supportsPushToTalk: info.supportsPushToTalk,
          pushToTalkUnavailableReason: info.pushToTalkUnavailableReason,
          doubleTapUnavailableReason: info.doubleTapUnavailableReason,
          linuxInputAccessDenied: info.linuxInputAccessDenied ?? false,
          hyprlandConfigStatus,
          loaded: true,
        });
      } catch (error) {
        logger.error("Failed to check hotkey mode", { error }, scope);
      }
    };
    const unsubscribe = window.electronAPI?.onHotkeyModeInfoChanged?.(checkHotkeyMode);
    void checkHotkeyMode();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [scope, hotkey]);

  return modeInfo;
}
