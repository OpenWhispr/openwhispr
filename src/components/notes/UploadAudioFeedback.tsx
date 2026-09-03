import React from "react";
import { cn } from "../lib/utils";

// Both completion warnings sit under the transcript preview and share its
// column, so they share one recipe; only the tone differs.
const COMPLETION_WARNING = "text-xs max-w-[240px] text-center mb-4 -mt-2";

interface UploadModelSettingsButtonProps {
  label: string;
  actionLabel: string;
  onOpenSettings?: (section: string) => void;
  className?: string;
}

export function UploadModelSettingsButton({
  label,
  actionLabel,
  onOpenSettings,
  className,
}: UploadModelSettingsButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpenSettings?.("uploadTranscription")}
      // WCAG 2.5.3: keep the visible label inside the accessible name, so the
      // model stays announced and voice control can still target the button.
      aria-label={`${label}, ${actionLabel}`}
      title={actionLabel}
      disabled={!onOpenSettings}
      className={cn(
        "rounded-sm underline underline-offset-2 decoration-foreground/30 transition-colors",
        "hover:text-foreground hover:decoration-foreground/50 active:text-foreground/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1",
        "disabled:pointer-events-none disabled:no-underline disabled:opacity-50",
        className
      )}
    >
      {label}
    </button>
  );
}

interface UploadCompleteWarningsProps {
  partialWarning: { failed: number; total: number } | null;
  diarizationWarning: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function UploadCompleteWarnings({
  partialWarning,
  diarizationWarning,
  t,
}: UploadCompleteWarningsProps): React.JSX.Element | null {
  if (!partialWarning && !diarizationWarning) return null;

  return (
    <>
      {partialWarning && (
        <p className={cn(COMPLETION_WARNING, "text-destructive/50")}>
          {t("notes.upload.partialWarningCount", {
            failed: partialWarning.failed,
            total: partialWarning.total,
          })}
        </p>
      )}
      {diarizationWarning && (
        <p className={cn(COMPLETION_WARNING, "text-warning")} role="status" aria-live="polite">
          {t("notes.upload.diarizationWarning")}
        </p>
      )}
    </>
  );
}
