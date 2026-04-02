import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";

interface DictationWidgetProps {
  isRecording: boolean;
  isProcessing: boolean;
  onStart: () => void;
  onStop: () => void;
  actionPicker?: React.ReactNode;
}

const BAR_COUNT = 7;
const WARNING_SECONDS = 60; // warn 1 minute before auto-stop

export default function DictationWidget({
  isRecording,
  isProcessing,
  onStart,
  onStop,
  actionPicker,
}: DictationWidgetProps) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const maxDuration = useSettingsStore((s) => s.maxDictationDurationSeconds);
  const autoStoppedRef = useRef(false);

  useEffect(() => {
    if (!isRecording) {
      setElapsed(0);
      autoStoppedRef.current = false;
      return;
    }
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  // Auto-stop when max duration reached
  useEffect(() => {
    if (!isRecording || maxDuration <= 0 || autoStoppedRef.current) return;
    if (elapsed >= maxDuration) {
      autoStoppedRef.current = true;
      onStop();
    }
  }, [elapsed, maxDuration, isRecording, onStop]);

  const isWarning = maxDuration > 0 && elapsed >= maxDuration - WARNING_SECONDS && elapsed < maxDuration;
  const remaining = maxDuration > 0 ? maxDuration - elapsed : null;

  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");

  const timerColorClass = isWarning
    ? "text-amber-500 dark:text-amber-400"
    : "text-primary/60 dark:text-primary/70";

  return (
    <div className="absolute bottom-5 left-0 right-0 z-10 flex justify-center pointer-events-none">
      {isRecording ? (
        <div
          className={cn(
            "flex items-center gap-4 h-12 px-5 rounded-xl pointer-events-auto",
            "bg-primary/6 dark:bg-primary/10",
            "backdrop-blur-xl",
            isWarning
              ? "border border-amber-500/40 dark:border-amber-400/40"
              : "border border-primary/20 dark:border-primary/25",
            "shadow-elevated"
          )}
          style={{
            animation: "grow-to-bar 0.45s cubic-bezier(0.22, 1, 0.36, 1) both",
          }}
        >
          <div
            className="flex items-end gap-0.75 h-5"
            style={{
              animation: "fade-in-content 0.3s ease-out 0.2s both",
            }}
          >
            {Array.from({ length: BAR_COUNT }, (_, i) => (
              <div
                key={i}
                className={cn(
                  "w-0.75 rounded-full origin-bottom",
                  isWarning
                    ? "bg-amber-500/70 dark:bg-amber-400/70"
                    : "bg-primary/60 dark:bg-primary/70"
                )}
                style={{
                  height: "100%",
                  animation: `waveform-bar ${0.6 + i * 0.08}s ease-in-out infinite`,
                  animationDelay: `${0.35 + i * 0.05}s`,
                }}
              />
            ))}
          </div>

          <span
            className={cn("text-xs font-medium tabular-nums min-w-9", timerColorClass)}
            style={{
              animation: "fade-in-content 0.3s ease-out 0.25s both",
            }}
          >
            {minutes}:{seconds}
          </span>

          {isWarning && remaining !== null && (
            <span
              className="text-[10px] font-medium text-amber-500 dark:text-amber-400 whitespace-nowrap"
              style={{
                animation: "fade-in-content 0.2s ease-out both",
              }}
            >
              {t("notes.editor.autoStopWarning", { seconds: remaining })}
            </span>
          )}

          <button
            onClick={onStop}
            className={cn(
              "flex items-center justify-center w-7 h-7 rounded-lg",
              "bg-primary/10 hover:bg-primary/18 active:bg-primary/25",
              "text-primary",
              "transition-colors duration-150"
            )}
            style={{
              animation: "fade-in-content 0.3s ease-out 0.3s both",
            }}
            aria-label={t("notes.editor.stop")}
          >
            <Square size={12} fill="currentColor" />
          </button>
        </div>
      ) : isProcessing ? (
        <div
          className={cn(
            "flex items-center gap-3 h-12 px-5 rounded-xl pointer-events-auto",
            "bg-primary/6 dark:bg-primary/10",
            "backdrop-blur-xl",
            "border border-primary/15 dark:border-primary/20",
            "shadow-elevated"
          )}
        >
          <Loader2 size={14} className="animate-spin text-primary/50" />
          <span className="text-xs font-medium text-primary/50">
            {t("notes.editor.processing")}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 pointer-events-auto">
          <button
            onClick={onStart}
            className={cn(
              "flex items-center justify-center w-11 h-11 rounded-full",
              "bg-primary/8 dark:bg-primary/12",
              "backdrop-blur-xl",
              "border border-primary/15 dark:border-primary/20",
              "shadow-sm hover:shadow-md",
              "text-primary/60 hover:text-primary",
              "transition-all duration-200",
              "hover:bg-primary/14 dark:hover:bg-primary/20",
              "hover:scale-105",
              "active:scale-[0.97]"
            )}
            aria-label={t("notes.editor.transcribe")}
          >
            <Mic size={16} />
          </button>
          {actionPicker}
        </div>
      )}
    </div>
  );
}
