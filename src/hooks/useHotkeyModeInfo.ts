import { useEffect, useMemo, useState } from "react";
import logger from "../utils/logger";
import { useUiLocale } from "./useUiLocale";

export interface HyprlandConfigStatus {
  canWrite: boolean;
  path: string;
}

export interface HotkeyModeInfo {
  isUsingNativeShortcut: boolean;
  isUsingHyprland: boolean;
  supportsPushToTalk: boolean;
  linuxPttPermissionDenied: boolean;
  pushToTalkUnavailableReason: string | null;
  hyprlandConfigStatus: HyprlandConfigStatus | null;
  /** False until main has answered; the defaults above are optimistic placeholders. */
  loaded: boolean;
}

const DEFAULT_INFO: HotkeyModeInfo = {
  isUsingNativeShortcut: false,
  isUsingHyprland: false,
  supportsPushToTalk: true,
  linuxPttPermissionDenied: false,
  pushToTalkUnavailableReason: null,
  hyprlandConfigStatus: null,
  loaded: false,
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
  const language = useUiLocale();
  const [denialGeneration, setDenialGeneration] = useState(0);
  const request = useMemo(
    () => ({ scope, hotkey, slot, language, denialGeneration }),
    [scope, hotkey, slot, language, denialGeneration]
  );
  const [resolved, setResolved] = useState<{
    request: typeof request;
    info: HotkeyModeInfo;
  } | null>(null);

  useEffect(() => {
    return window.electronAPI?.onLinuxPttPermissionDenied?.(() => {
      setDenialGeneration((generation) => generation + 1);
    });
  }, []);

  useEffect(() => {
    const { scope, hotkey, slot, language } = request;
    let cancelled = false;
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo?.(hotkey, slot, language);
        if (!info || cancelled) return;
        const hyprlandConfigStatus = info.isUsingHyprland
          ? ((await window.electronAPI?.getHyprlandConfigStatus?.()) ?? null)
          : null;
        if (cancelled) return;
        setResolved({
          request,
          info: {
            isUsingNativeShortcut: info.isUsingNativeShortcut,
            isUsingHyprland: info.isUsingHyprland,
            supportsPushToTalk: info.supportsPushToTalk,
            linuxPttPermissionDenied: info.linuxPttPermissionDenied,
            pushToTalkUnavailableReason: info.pushToTalkUnavailableReason,
            hyprlandConfigStatus,
            loaded: true,
          },
        });
      } catch (error) {
        logger.error("Failed to check hotkey mode", { error }, scope);
      }
    };
    checkHotkeyMode();
    return () => {
      cancelled = true;
    };
  }, [request]);

  // Keep backend/editor limits stable while a new key or language is checked,
  // but do not present the previous request's explanation as current.
  const loaded = resolved?.request === request;
  return {
    ...(resolved?.info ?? DEFAULT_INFO),
    pushToTalkUnavailableReason: loaded ? resolved.info.pushToTalkUnavailableReason : null,
    loaded,
  };
}
