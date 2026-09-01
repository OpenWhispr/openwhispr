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
  hyprlandConfigStatus: HyprlandConfigStatus | null;
}

const DEFAULT_INFO: HotkeyModeInfo = {
  isUsingNativeShortcut: false,
  isUsingHyprland: false,
  supportsPushToTalk: true,
  pushToTalkUnavailableReason: null,
  hyprlandConfigStatus: null,
};

/**
 * Resolves how a slot's hotkey is registered for the current session
 * (native shortcut, Hyprland) and, on Hyprland, whether its config is
 * persistable. `scope` tags log output for the calling surface; `slot`
 * defaults to dictation.
 */
export function useHotkeyModeInfo(
  scope: string,
  hotkey?: string,
  slot?: "dictation" | "voiceAgent" | "translation"
): HotkeyModeInfo {
  const [modeInfo, setModeInfo] = useState<HotkeyModeInfo>(DEFAULT_INFO);

  useEffect(() => {
    let cancelled = false;
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo?.(hotkey, slot);
        if (!info || cancelled) return;
        const hyprlandConfigStatus = info.isUsingHyprland
          ? ((await window.electronAPI?.getHyprlandConfigStatus?.()) ?? null)
          : null;
        if (cancelled) return;
        setModeInfo({
          isUsingNativeShortcut: info.isUsingNativeShortcut,
          isUsingHyprland: info.isUsingHyprland,
          supportsPushToTalk: info.supportsPushToTalk,
          pushToTalkUnavailableReason: info.pushToTalkUnavailableReason,
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
  }, [scope, hotkey, slot]);

  return modeInfo;
}
