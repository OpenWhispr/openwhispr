import { useState, useCallback, useEffect } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { PasteToolsResult } from "../types/electron";
import { useLocalStorage } from "./useLocalStorage";

export interface UsePermissionsReturn {
  // State
  micPermissionGranted: boolean;
  accessibilityPermissionGranted: boolean;
  micPermissionError: string | null;
  pasteToolsInfo: PasteToolsResult | null;
  isCheckingPasteTools: boolean;

  requestMicPermission: () => Promise<void>;
  testAccessibilityPermission: () => Promise<void>;
  checkPasteToolsAvailability: () => Promise<PasteToolsResult | null>;
  openMicPrivacySettings: () => Promise<void>;
  openSoundInputSettings: () => Promise<void>;
  openAccessibilitySettings: () => Promise<void>;
  setMicPermissionGranted: (granted: boolean) => void;
  setAccessibilityPermissionGranted: (granted: boolean) => void;
}

export interface UsePermissionsProps {
  showAlertDialog: (dialog: { title: string; description?: string }) => void;
}

const stopTracks = (stream?: MediaStream) => {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // ignore track cleanup errors
  }
};

const getPlatformSettingsPath = (t: TFunction): string => {
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("win")) return t("hooks.permissions.paths.windowsMicrophone");
    if (ua.includes("linux")) return t("hooks.permissions.paths.linuxSound");
  }
  return t("hooks.permissions.paths.defaultSound");
};

const getPlatformPrivacyPath = (t: TFunction): string => {
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("win")) return t("hooks.permissions.paths.windowsMicrophone");
    if (ua.includes("linux")) return t("hooks.permissions.paths.linuxPrivacy");
  }
  return t("hooks.permissions.paths.defaultPrivacy");
};

const getPlatform = (): "darwin" | "win32" | "linux" => {
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
  return "darwin"; // Default fallback
};

const describeMicError = (error: unknown, t: TFunction): string => {
  if (!error || typeof error !== "object") {
    return t("hooks.permissions.micErrors.accessFailed");
  }

  const err = error as { name?: string; message?: string };
  const name = err.name || "";
  const message = (err.message || "").toLowerCase();
  const settingsPath = getPlatformSettingsPath(t);
  const privacyPath = getPlatformPrivacyPath(t);

  if (name === "NotFoundError") {
    return t("hooks.permissions.micErrors.noMicrophones", { settingsPath });
  }

  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("hooks.permissions.micErrors.permissionDenied", { privacyPath });
  }

  if (name === "NotReadableError" || name === "AbortError") {
    return t("hooks.permissions.micErrors.couldNotStart", { settingsPath });
  }

  if (message.includes("no audio input") || message.includes("not available")) {
    return t("hooks.permissions.micErrors.noActiveInput", { settingsPath });
  }

  return t("hooks.permissions.micErrors.unknown", {
    error: err.message || t("hooks.permissions.micErrors.unknownFallback"),
  });
};

export const usePermissions = (
  showAlertDialog?: UsePermissionsProps["showAlertDialog"]
): UsePermissionsReturn => {
  const { t } = useTranslation();
  const [micPermissionGranted, setMicPermissionGranted] = useLocalStorage(
    "micPermissionGranted",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null);
  const [accessibilityPermissionGranted, setAccessibilityPermissionGranted] = useLocalStorage(
    "accessibilityPermissionGranted",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );
  const [pasteToolsInfo, setPasteToolsInfo] = useState<PasteToolsResult | null>(null);
  const [isCheckingPasteTools, setIsCheckingPasteTools] = useState(false);

  const openSystemSettings = useCallback(
    async (
      settingType: "microphone" | "sound" | "accessibility",
      apiMethod: () => Promise<{ success: boolean; error?: string } | undefined> | undefined
    ) => {
      const titles = {
        microphone: t("hooks.permissions.settingsTitles.microphone"),
        sound: t("hooks.permissions.settingsTitles.sound"),
        accessibility: t("hooks.permissions.settingsTitles.accessibility"),
      };
      const unableToOpenDescriptions = {
        microphone: t("hooks.permissions.settingsErrors.unableToOpenMicrophone"),
        sound: t("hooks.permissions.settingsErrors.unableToOpenSound"),
        accessibility: t("hooks.permissions.settingsErrors.unableToOpenAccessibility"),
      };
      try {
        const result = await apiMethod?.();
        if (result && !result.success && result.error) {
          showAlertDialog?.({ title: titles[settingType], description: result.error });
        }
      } catch (error) {
        console.error(`Failed to open ${settingType} settings:`, error);
        showAlertDialog?.({
          title: titles[settingType],
          description: unableToOpenDescriptions[settingType],
        });
      }
    },
    [showAlertDialog, t]
  );

  const openMicPrivacySettings = useCallback(
    () => openSystemSettings("microphone", window.electronAPI?.openMicrophoneSettings),
    [openSystemSettings]
  );

  const openSoundInputSettings = useCallback(
    () => openSystemSettings("sound", window.electronAPI?.openSoundInputSettings),
    [openSystemSettings]
  );

  const openAccessibilitySettings = useCallback(
    () => openSystemSettings("accessibility", window.electronAPI?.openAccessibilitySettings),
    [openSystemSettings]
  );

  const requestMicPermission = useCallback(async () => {
    if (!navigator?.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      const message = t("hooks.permissions.micUnavailable");
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphoneUnavailable"),
          description: message,
        });
      } else {
        alert(message);
      }
      return;
    }

    setMicPermissionError(null);

    try {
      // macOS hardened runtime requires main-process mic prompt before getUserMedia works
      if (window.electronAPI?.requestMicrophoneAccess) {
        try {
          await window.electronAPI.requestMicrophoneAccess();
        } catch {
          // ignored — getUserMedia below will surface the error
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopTracks(stream);
      setMicPermissionGranted(true);
      setMicPermissionError(null);
    } catch (err) {
      console.error("Microphone permission denied:", err);
      const message = describeMicError(err, t);
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphonePermissionRequired"),
          description: message,
        });
      } else {
        alert(message);
      }
    }
  }, [showAlertDialog, t]);

  const checkPasteToolsAvailability = useCallback(async (): Promise<PasteToolsResult | null> => {
    setIsCheckingPasteTools(true);
    try {
      if (window.electronAPI?.checkPasteTools) {
        const result = await window.electronAPI.checkPasteTools();
        setPasteToolsInfo(result);

        // On Windows and Linux with tools available, auto-grant accessibility
        if (result.platform === "win32") {
          setAccessibilityPermissionGranted(true);
        } else if (result.platform === "linux" && result.available) {
          setAccessibilityPermissionGranted(true);
        }
        return result;
      }
      return null;
    } catch (error) {
      console.error("Failed to check paste tools:", error);
      return null;
    } finally {
      setIsCheckingPasteTools(false);
    }
  }, [setAccessibilityPermissionGranted]);

  // Check paste tools on mount
  useEffect(() => {
    checkPasteToolsAvailability();
  }, [checkPasteToolsAvailability]);

  // On macOS, re-validate accessibility permission on mount to override stale
  // localStorage values (e.g. after app update changes the code signature).
  useEffect(() => {
    if (getPlatform() !== "darwin") return;
    window.electronAPI?.checkAccessibilityPermission?.().then((granted) => {
      if (!granted) {
        setAccessibilityPermissionGranted(false);
      }
    });
  }, [setAccessibilityPermissionGranted]);

  const testAccessibilityPermission = useCallback(async () => {
    const platform = getPlatform();

    // On macOS, actually test the accessibility permission
    if (platform === "darwin") {
      try {
        await window.electronAPI.pasteText(t("hooks.permissions.accessibilityTestText"));
        setAccessibilityPermissionGranted(true);
      } catch (err) {
        console.error("Accessibility permission test failed:", err);
        if (showAlertDialog) {
          showAlertDialog({
            title: t("hooks.permissions.titles.accessibilityNeeded"),
            description: t("hooks.permissions.descriptions.accessibilityNeeded"),
          });
        } else {
          alert(t("hooks.permissions.alerts.accessibilityNeeded"));
        }
      }
      return;
    }

    // On Windows, PowerShell SendKeys is always available
    if (platform === "win32") {
      setAccessibilityPermissionGranted(true);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.readyToGo"),
          description: t("hooks.permissions.descriptions.windowsReady"),
        });
      }
      return;
    }

    // On Linux, check if paste tools are available
    if (platform === "linux") {
      const result = await checkPasteToolsAvailability();

      if (result?.available) {
        setAccessibilityPermissionGranted(true);
        if (showAlertDialog) {
          const method = result.method || t("hooks.permissions.labels.defaultPasteTool");
          const methodLabel =
            result.isWayland && method === "xdotool"
              ? t("hooks.permissions.labels.xdotoolXwayland")
              : method;
          showAlertDialog({
            title: t("hooks.permissions.titles.readyToGo"),
            description: t("hooks.permissions.descriptions.linuxReadyWithMethod", {
              method: methodLabel,
            }),
          });
        }
      } else {
        // Don't block, but inform the user
        const isWayland = result?.isWayland;
        const xwaylandAvailable = result?.xwaylandAvailable;
        const recommendedTool = result?.recommendedInstall;
        const installCmd =
          recommendedTool === "wtype"
            ? "sudo dnf install wtype  # Fedora\nsudo apt install wtype  # Debian/Ubuntu"
            : "sudo apt install xdotool  # Debian/Ubuntu/Mint\nsudo dnf install xdotool  # Fedora";

        if (showAlertDialog) {
          if (isWayland && !xwaylandAvailable && !recommendedTool) {
            showAlertDialog({
              title: t("hooks.permissions.titles.waylandClipboardMode"),
              description: t("hooks.permissions.descriptions.waylandClipboardMode"),
            });
          } else {
            const waylandNote = isWayland
              ? recommendedTool === "wtype"
                ? t("hooks.permissions.notes.waylandWtype")
                : t("hooks.permissions.notes.waylandXwaylandOnly")
              : "";
            showAlertDialog({
              title: t("hooks.permissions.titles.optionalPasteTool"),
              description: t("hooks.permissions.descriptions.optionalPasteTool", {
                tool: recommendedTool || t("hooks.permissions.labels.defaultPasteTool"),
                installCmd,
                waylandNote,
              }),
            });
          }
        }
        // Still allow proceeding - this is optional
        setAccessibilityPermissionGranted(true);
      }
    }
  }, [showAlertDialog, checkPasteToolsAvailability, setAccessibilityPermissionGranted, t]);

  return {
    micPermissionGranted,
    accessibilityPermissionGranted,
    micPermissionError,
    pasteToolsInfo,
    isCheckingPasteTools,
    requestMicPermission,
    testAccessibilityPermission,
    checkPasteToolsAvailability,
    openMicPrivacySettings,
    openSoundInputSettings,
    openAccessibilitySettings,
    setMicPermissionGranted,
    setAccessibilityPermissionGranted,
  };
};
