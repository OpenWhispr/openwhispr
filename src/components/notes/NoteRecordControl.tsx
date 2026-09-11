import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Mic, Square } from "../icons";
import { cn } from "../lib/utils";
import { LiveWaveform } from "../ui/LiveWaveform";
import { GRADIENT_CIRCLE } from "../ui/gradientCircle";
import { analyserRms } from "../../utils/audioLevel";
import { formatMmSs } from "../../utils/formatDuration";
import { getMicAnalyser, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";

// Module-level buffer: there is a single meeting mic analyser at a time.
const micLevelBuf: { current: Float32Array<ArrayBuffer> | null } = { current: null };

function readMeetingMicLevel(): number {
  const analyser = getMicAnalyser();
  if (!analyser) return useMeetingRecordingStore.getState().currentMicLevel;
  return analyserRms(analyser, micLevelBuf);
}

// Same near-opaque surface the ask bar wears while recording, so the two capsules match.
const RECORDING_SURFACE = "bg-surface-2/95 shadow-(--shadow-glass)";

const WAVE_BAR_HEIGHTS = [6, 12, 9, 11];

/** Four-bar pulse shown in the Transcript tab while a recording is running. */
export function RecordingWave({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex h-3 items-center gap-px", className)}>
      {WAVE_BAR_HEIGHTS.map((height, i) => (
        <span
          key={i}
          className="w-0.5 rounded-full bg-primary animate-[ow-wave_1s_ease-in-out_infinite] motion-reduce:animate-none"
          style={{ height, animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

interface NoteRecordControlProps {
  isRecording: boolean;
  isProcessing: boolean;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}

/** Record button for the note header: a brand circle that widens into a stop + live-wave + timer pill. */
export default function NoteRecordControl({
  isRecording,
  isProcessing,
  disabled = false,
  onStart,
  onStop,
}: NoteRecordControlProps) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRecording) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  return (
    <div
      className={cn(
        "h-[30px] shrink-0 overflow-hidden transition-[width] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
        isRecording ? "w-40" : "w-[30px]"
      )}
    >
      {isRecording ? (
        <button
          type="button"
          onClick={onStop}
          aria-label={t("notes.editor.stop")}
          title={t("notes.editor.stop")}
          className={cn(
            "group flex h-[30px] w-full items-center gap-2 rounded-full ps-1 pe-3",
            RECORDING_SURFACE,
            "border border-primary/15 transition-[border-color] duration-200 hover:border-primary/30",
            "dark:border-primary/25 dark:hover:border-primary/40",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          )}
        >
          <span
            className={cn(
              "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full",
              GRADIENT_CIRCLE,
              "transition-[filter] duration-150 group-hover:brightness-110"
            )}
          >
            <Square size={8} fill="currentColor" />
          </span>
          <LiveWaveform readLevel={readMeetingMicLevel} bars={10} className="h-3.5 flex-1" />
          <span className="shrink-0 text-xs font-medium tabular-nums text-foreground/85">
            {formatMmSs(elapsed)}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onStart}
          disabled={disabled || isProcessing}
          aria-label={t("notes.editor.transcribe")}
          title={disabled ? t("common.managedByOrg") : undefined}
          className={cn(
            "flex h-[30px] w-[30px] items-center justify-center rounded-full",
            GRADIENT_CIRCLE,
            "transition-[filter,transform] duration-150 hover:brightness-110 active:scale-95",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
            disabled && "pointer-events-none opacity-40 saturate-0",
            isProcessing && "pointer-events-none"
          )}
        >
          {isProcessing ? (
            <Loader2 size={14} className="animate-spin text-white/90" />
          ) : (
            <Mic size={15} />
          )}
        </button>
      )}
    </div>
  );
}
