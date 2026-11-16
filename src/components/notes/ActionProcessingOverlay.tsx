import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { blurBehindOverlays } from "../ui/overlayBlur";
import type { ActionProcessingState } from "../../hooks/useActionProcessing";
import type { NoteActionProgress } from "../../stores/actionProcessingStore";

// The card's tint mixed into the background rather than laid over it: opaque, so on Linux, with
// no blur, the scanner line passes behind the label instead of through it.
const OPAQUE_ACCENT_CARD =
  "bg-[color-mix(in_oklab,var(--color-accent-solid)_6%,var(--color-surface-primary))] dark:bg-[color-mix(in_oklab,var(--color-accent-solid)_8%,var(--color-surface-primary))]";
const OPAQUE_SUCCESS_CARD =
  "bg-[color-mix(in_oklab,var(--color-green-solid)_6%,var(--color-surface-primary))] dark:bg-[color-mix(in_oklab,var(--color-green-solid)_8%,var(--color-surface-primary))]";

interface ActionProcessingOverlayProps {
  state: ActionProcessingState;
  actionName: string | null;
  /** Set while a long note is summarised in parts. */
  progress?: NoteActionProgress | null;
  /** Offered while processing: a run in parts takes minutes, and only quitting stopped it before. */
  onCancel?: () => void;
}

export default function ActionProcessingOverlay({
  state,
  actionName,
  progress = null,
  onCancel,
}: ActionProcessingOverlayProps) {
  const { t } = useTranslation();
  // A mount mid-run is a note switch (NoteEditor is keyed by note id); the
  // overlay must show without waiting for a state change that already happened.
  const [visible, setVisible] = useState(state !== "idle");
  const [prevState, setPrevState] = useState(state);

  if (state !== prevState) {
    setPrevState(state);
    if (state === "processing" || state === "success") {
      setVisible(true);
    }
  }

  useEffect(() => {
    if (state !== "idle") return;
    const id = setTimeout(() => setVisible(false), 300);
    return () => clearTimeout(id);
  }, [state]);

  if (!visible) return null;

  const isSuccess = state === "success";
  const isFadingOut = state === "idle";

  return (
    // No blur on Linux: Linux can composite on the CPU, which would redraw it on every frame
    // of the scanner animation for as long as an action runs (#2298). A denser tint stands in.
    <div
      className={cn(
        "absolute inset-0 z-[5] flex items-center justify-center",
        blurBehindOverlays
          ? "bg-surface-primary/60 dark:bg-surface-primary/70 backdrop-blur-md"
          : "bg-surface-primary/90",
        "transition-opacity duration-300",
        isFadingOut && "opacity-0 pointer-events-none"
      )}
      style={!isFadingOut ? { animation: "float-up 0.25s ease-out" } : undefined}
    >
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.02]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 3px, currentColor 3px, currentColor 4px)",
        }}
      />

      <div
        className={cn(
          "absolute left-0 right-0 h-[2px] pointer-events-none scanner-sweep-line",
          isSuccess ? "bg-green-solid/60" : "bg-accent-solid/60"
        )}
        style={{
          animation: isSuccess ? "none" : "scanner-sweep 2.5s ease-in-out infinite",
          boxShadow: isSuccess
            ? "0 0 24px 8px color-mix(in oklch, var(--color-green-solid) 20%, transparent)"
            : "0 0 24px 8px color-mix(in oklch, var(--color-accent-solid) 15%, transparent)",
          ...(isSuccess ? { top: "50%" } : {}),
        }}
      />

      <div
        className={cn(
          "relative flex flex-col items-center gap-2.5",
          isSuccess
            ? "border-green-solid/12 dark:border-green-solid/15"
            : "border-accent-solid/12 dark:border-accent-solid/15",
          blurBehindOverlays
            ? cn(
                isSuccess
                  ? "bg-green-solid/6 dark:bg-green-solid/8"
                  : "bg-accent-solid/6 dark:bg-accent-solid/8",
                "backdrop-blur-xl"
              )
            : isSuccess
              ? OPAQUE_SUCCESS_CARD
              : OPAQUE_ACCENT_CARD,
          "border rounded-xl px-6 py-3 shadow-elevated",
          "transition-colors duration-300"
        )}
      >
        {isSuccess ? (
          <div className="flex items-center gap-2">
            <Check size={13} className="text-green-solid/70" />
            <span className="text-xs font-medium text-green/70 tracking-tight">
              {t("notes.actions.done")}
            </span>
          </div>
        ) : (
          <>
            <span className="text-xs font-medium text-accent-solid/70 tracking-tight">
              {actionName}
            </span>
            {progress ? (
              <span className="text-[11px] text-accent-solid/50 tracking-tight">
                {t("notes.actions.chunkProgress", { step: progress.step, total: progress.total })}
              </span>
            ) : null}
            <div className="w-32 h-0.5 bg-accent-solid/10 rounded-full overflow-hidden">
              <div
                className="h-full w-1/3 bg-accent-solid/40 rounded-full"
                style={{ animation: "indeterminate 1.5s ease-in-out infinite" }}
                data-scanner-progress=""
              />
            </div>
            {onCancel ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCancel}
                className="h-6 px-2 text-[11px] text-accent-solid/60 hover:text-accent-solid hover:bg-accent-solid/8 dark:text-accent-solid/60 dark:hover:text-accent-solid dark:hover:bg-accent-solid/8"
              >
                {t("common.cancel")}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
