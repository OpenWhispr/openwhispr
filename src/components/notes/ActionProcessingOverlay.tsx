import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import type { ActionProcessingState } from "../../hooks/useActionProcessing";

interface ActionProcessingOverlayProps {
  state: ActionProcessingState;
  actionName: string | null;
}

export default function ActionProcessingOverlay({
  state,
  actionName,
}: ActionProcessingOverlayProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (state === "processing" || state === "success") {
      setVisible(true);
    } else if (state === "idle") {
      const id = setTimeout(() => setVisible(false), 300);
      return () => clearTimeout(id);
    }
  }, [state]);

  if (!visible) return null;

  const isSuccess = state === "success";
  const isFadingOut = state === "idle";

  return (
    <div
      className={cn(
        "absolute inset-0 z-[5] flex items-center justify-center",
        "bg-background/60 dark:bg-background/70 backdrop-blur-md",
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
          isSuccess ? "bg-success/60" : "bg-accent/60"
        )}
        style={{
          animation: isSuccess ? "none" : "scanner-sweep 2.5s ease-in-out infinite",
          boxShadow: isSuccess
            ? "0 0 24px 8px color-mix(in oklch, var(--color-success) 20%, transparent)"
            : "0 0 24px 8px color-mix(in oklch, var(--color-accent) 15%, transparent)",
          ...(isSuccess ? { top: "50%" } : {}),
        }}
      />

      <div
        className={cn(
          "relative flex flex-col items-center gap-2.5",
          isSuccess
            ? "bg-success/6 dark:bg-success/8 border-success/12 dark:border-success/15"
            : "bg-accent/6 dark:bg-accent/8 border-accent/12 dark:border-accent/15",
          "backdrop-blur-xl border rounded-xl px-6 py-3 shadow-elevated",
          "transition-colors duration-300"
        )}
      >
        {isSuccess ? (
          <div className="flex items-center gap-2">
            <Check size={13} className="text-success/70" />
            <span className="text-xs font-medium text-success/70 tracking-tight">
              {t("notes.actions.done")}
            </span>
          </div>
        ) : (
          <>
            <span className="text-xs font-medium text-accent/70 tracking-tight">{actionName}</span>
            <div className="w-32 h-0.5 bg-accent/10 rounded-full overflow-hidden">
              <div
                className="h-full w-1/3 bg-accent/40 rounded-full"
                style={{ animation: "indeterminate 1.5s ease-in-out infinite" }}
                data-scanner-progress=""
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
