import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Square } from "../icons";
import { stopRecording, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";
import { cn } from "../lib/utils";
import { isControlPanelWindow } from "../../utils/windowContext";

interface MeetingRecordingPillProps {
  activeView: string;
  activeNoteId: number | null;
  onReturnToNote: () => void;
}

const BAR_COUNT = 4;
const BAR_FLOOR = 12;

const truncateTitle = (title: string) =>
  title.length > 20 ? `${title.slice(0, 19).trimEnd()}…` : title;

const computeBarHeight = (level: number, index: number) => {
  // Per-bar phase keeps the stack from moving in lockstep at sustained levels.
  // sqrt curve maps small RMS values (typical speech ~0.05-0.1) into a
  // visible range — linear scaling kept bars clamped at the floor.
  const phase = 0.7 + 0.3 * Math.sin(index * 1.7);
  const scaled = Math.sqrt(level) * 180 * phase;
  return `${Math.max(BAR_FLOOR, Math.min(100, scaled))}%`;
};

export default function MeetingRecordingPill({
  activeView,
  activeNoteId,
  onReturnToNote,
}: MeetingRecordingPillProps) {
  const { t } = useTranslation();
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const recordingNoteTitle = useMeetingRecordingStore((s) => s.recordingNoteTitle);
  const micLevel = useMeetingRecordingStore((s) => s.currentMicLevel);
  const micCaptureStatus = useMeetingRecordingStore((s) => s.micCaptureStatus);
  const isWaitingForMic = micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable";
  const [isStopping, setIsStopping] = useState(false);

  const isViewingRecordingNote =
    activeView === "personal-notes" && activeNoteId === recordingNoteId;

  if (!isRecording || isViewingRecordingNote || !isControlPanelWindow()) {
    return null;
  }

  const handleStop = async () => {
    if (isStopping) return;
    setIsStopping(true);
    try {
      await stopRecording();
    } finally {
      setIsStopping(false);
    }
  };

  const title = truncateTitle(recordingNoteTitle ?? "");
  const returnLabel = t("notes.meetingPill.returnToNote");
  const stopLabel = t("notes.editor.stop");

  return createPortal(
    <div
      className="fixed top-2 left-1/2 -translate-x-1/2 z-30"
      style={
        {
          WebkitAppRegion: "no-drag",
          animation: "grow-to-bar 0.45s cubic-bezier(0.22, 1, 0.36, 1) both",
        } as React.CSSProperties
      }
    >
      <div
        className={cn(
          "flex items-center gap-2 h-9 px-3 rounded-xl",
          "bg-surface-primary/95 dark:bg-surface-primary/95",
          "backdrop-blur-xl",
          "border border-brand-solid/25 dark:border-brand-solid/30",
          "shadow-elevated"
        )}
      >
        <button
          type="button"
          onClick={onReturnToNote}
          aria-label={returnLabel}
          title={returnLabel}
          className={cn(
            "flex items-center gap-3 px-1 -mx-1 rounded-md",
            "transition-colors",
            "hover:bg-brand-solid/8 active:bg-brand-solid/14",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus/30"
          )}
        >
          <div className="flex items-end gap-0.75 h-4">
            {Array.from({ length: BAR_COUNT }, (_, i) => (
              <div
                key={i}
                className={cn(
                  "w-0.75 rounded-full origin-bottom",
                  isWaitingForMic ? "bg-amber-solid" : "bg-brand-solid/60 dark:bg-brand-solid/70"
                )}
                style={{ height: computeBarHeight(micLevel, i) }}
              />
            ))}
          </div>
          <span className="text-xs font-medium text-primary/80 truncate max-w-[12rem]">
            {isWaitingForMic ? t("notes.meetingPill.waitingForMicrophone") : title}
          </span>
        </button>

        <button
          type="button"
          onClick={handleStop}
          disabled={isStopping}
          aria-label={stopLabel}
          title={stopLabel}
          className={cn(
            "flex items-center justify-center w-7 h-7 rounded-lg",
            "transition-colors duration-150",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus/30",
            isStopping
              ? "bg-brand-solid/6 text-brand-solid/40 cursor-not-allowed"
              : "bg-brand-solid/10 hover:bg-brand-solid/18 active:bg-brand-solid/25 text-brand-solid"
          )}
        >
          <Square size={12} fill="currentColor" />
        </button>
      </div>
    </div>,
    document.body
  );
}
