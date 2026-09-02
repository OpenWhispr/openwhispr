import React from "react";
import { cn } from "../lib/utils";

interface UploadModelSettingsButtonProps {
  label: string;
  ariaLabel: string;
  onOpenSettings?: (section: string) => void;
  className?: string;
}

export function UploadModelSettingsButton({
  label,
  ariaLabel,
  onOpenSettings,
  className,
}: UploadModelSettingsButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpenSettings?.("uploadTranscription")}
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={!onOpenSettings}
      className={cn(
        "rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:pointer-events-none",
        className
      )}
    >
      {label}
    </button>
  );
}

export function UploadDiarizationWarning({ message }: { message: string }): React.JSX.Element {
  return (
    <p
      className="text-xs text-amber-700 dark:text-amber-300 max-w-[240px] text-center mb-4 -mt-2"
      role="status"
      aria-live="polite"
    >
      {message}
    </p>
  );
}
