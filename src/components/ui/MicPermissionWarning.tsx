import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { AlertCircle } from "lucide-react";
import { cn } from "../lib/utils";

interface MicPermissionWarningProps {
  error: string | null;
  onOpenSoundSettings: () => void;
  onOpenPrivacySettings: () => void;
}

type Platform = "darwin" | "win32" | "linux";

const getPlatform = (): Platform => {
  if (typeof window !== "undefined" && window.electronAPI?.getPlatform) {
    const p = window.electronAPI.getPlatform();
    if (p === "darwin" || p === "win32" || p === "linux") return p;
  }
  // Fallback to user agent
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "darwin";
    if (ua.includes("linux")) return "linux";
  }
  return "win32";
};

export default function MicPermissionWarning({
  error,
  onOpenSoundSettings,
  onOpenPrivacySettings,
}: MicPermissionWarningProps) {
  const { t } = useTranslation();
  const config = useMemo(() => {
    const platformConfig: Record<
      Platform,
      { message: string; soundLabel: string; privacyLabel: string; showPrivacyButton: boolean }
    > = {
      darwin: {
        message: t("hooks.permissions.warning.messages.macos"),
        soundLabel: t("hooks.permissions.warning.soundLabel"),
        privacyLabel: t("hooks.permissions.warning.privacyLabel"),
        showPrivacyButton: true,
      },
      win32: {
        message: t("hooks.permissions.warning.messages.windows"),
        soundLabel: t("hooks.permissions.warning.soundLabel"),
        privacyLabel: t("hooks.permissions.warning.privacyLabel"),
        showPrivacyButton: true,
      },
      linux: {
        message: t("hooks.permissions.warning.messages.linux"),
        soundLabel: t("hooks.permissions.warning.soundLabel"),
        privacyLabel: "",
        showPrivacyButton: false,
      },
    };
    return platformConfig[getPlatform()];
  }, [t]);

  return (
    <div
      className={cn(
        "rounded-md p-2.5 border",
        "bg-warning/8 border-warning/20 dark:bg-warning/10 dark:border-warning/20"
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-md bg-warning/15 flex items-center justify-center shrink-0">
          <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-warning" />
        </div>
        <p className="flex-1 text-xs text-amber-700 dark:text-warning/90 leading-snug">
          {error || config.message}
        </p>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSoundSettings}
            className="h-6 px-2 text-xs text-amber-700 hover:text-amber-800 hover:bg-amber-100 dark:text-warning dark:hover:text-warning dark:hover:bg-warning/10"
          >
            {config.soundLabel}
          </Button>
          {config.showPrivacyButton && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenPrivacySettings}
              className="h-6 px-2 text-xs text-amber-700 hover:text-amber-800 hover:bg-amber-100 dark:text-warning dark:hover:text-warning dark:hover:bg-warning/10"
            >
              {config.privacyLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
