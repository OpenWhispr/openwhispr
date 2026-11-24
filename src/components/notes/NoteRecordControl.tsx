import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Loader2, Mic, Square, Volume } from "../icons";
import { cn } from "../lib/utils";
import { LiveWaveform } from "../ui/LiveWaveform";
import { GRADIENT_CIRCLE } from "../ui/gradientCircle";
import { analyserRms } from "../../utils/audioLevel";
import { formatMmSs } from "../../utils/formatDuration";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  getMicAnalyser,
  useMeetingRecordingStore,
  type MeetingAudioSource,
} from "../../stores/meetingRecordingStore";

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
  disabledReason?: string;
  onStart: (audioSource?: MeetingAudioSource) => void;
  onStop: () => void;
}

/** Record button for the note header: a brand circle that widens into a stop + live-wave + timer pill. */
export default function NoteRecordControl({
  isRecording,
  isProcessing,
  disabled = false,
  disabledReason,
  onStart,
  onStop,
}: NoteRecordControlProps) {
  const { t } = useTranslation();
  const reasonId = useId();
  const reason = disabled ? (disabledReason ?? t("common.managedByOrg")) : undefined;
  // Elapsed time comes from the session's start timestamp rather than a tick
  // count: this control remounts whenever the user switches notes, and counted
  // ticks would restart at zero (and drift while the window is throttled).
  const startedAt = useMeetingRecordingStore((s) => s.recordingStartedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRecording) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  const elapsed = isRecording && startedAt != null ? Math.floor((now - startedAt) / 1000) : 0;
  const startDisabled = disabled || isProcessing;
  // Unknown until the menu first opens; only a device that cannot capture
  // system audio at all disables the system-only choice.
  const [systemAudioSupported, setSystemAudioSupported] = useState<boolean | null>(null);
  const checkSystemAudio = (open: boolean) => {
    if (!open) return;
    void window.electronAPI
      ?.checkSystemAudioAccess?.()
      .then((access) => setSystemAudioSupported(access?.mode !== "unsupported"))
      .catch(() => setSystemAudioSupported(null));
  };

  return (
    <div
      className={cn(
        "h-[30px] shrink-0 overflow-hidden transition-[width] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
        isRecording ? "w-40" : "w-[50px]"
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
        <div className="flex h-[30px] items-center">
          <button
            type="button"
            onClick={() => onStart()}
            disabled={startDisabled}
            aria-label={t("notes.editor.transcribe")}
            aria-describedby={reason ? reasonId : undefined}
            title={reason}
            className={cn(
              "flex h-[30px] w-[30px] items-center justify-center rounded-full",
              GRADIENT_CIRCLE,
              "transition-[filter,transform] duration-150 enabled:hover:brightness-110 enabled:active:scale-95",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              // Keeps pointer events so hovering still shows why recording is off.
              disabled && "cursor-not-allowed opacity-40 saturate-0",
              isProcessing && "pointer-events-none"
            )}
          >
            {isProcessing ? (
              <Loader2 size={14} className="animate-spin text-white/90" />
            ) : (
              <Mic size={15} />
            )}
          </button>
          <DropdownMenu onOpenChange={checkSystemAudio}>
            <DropdownMenuTrigger asChild disabled={startDisabled}>
              <button
                type="button"
                aria-label={t("notes.editor.recordSource.menuLabel")}
                aria-describedby={reason ? reasonId : undefined}
                title={reason ?? t("notes.editor.recordSource.menuLabel")}
                className={cn(
                  "flex h-[30px] w-5 items-center justify-center rounded-full text-foreground/55",
                  "transition-colors duration-150 enabled:hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30",
                  startDisabled && "cursor-not-allowed opacity-40"
                )}
              >
                <ChevronDown size={12} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => onStart("both")} className="gap-2">
                <Mic size={14} className="shrink-0 text-foreground/60" />
                {t("notes.editor.recordSource.both")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onStart("system")}
                disabled={systemAudioSupported === false}
                className="items-start gap-2"
              >
                <Volume size={14} className="mt-0.5 shrink-0 text-foreground/60" />
                <span className="flex flex-col">
                  {t("notes.editor.recordSource.system")}
                  {systemAudioSupported === false && (
                    <span className="text-xs text-muted-foreground">
                      {t("notes.editor.recordSource.systemUnavailable")}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {reason && (
            <span id={reasonId} hidden>
              {reason}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
