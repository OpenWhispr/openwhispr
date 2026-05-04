import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Square } from "lucide-react";
import { stopRecording, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";
import { cn } from "../lib/utils";

interface MeetingRecordingPillProps {
  activeView: string;
  activeNoteId: number | null;
  onReturnToNote: () => void;
}

const BAR_COUNT = 4;
const BAR_FLOOR = 20;

const isControlPanelWindow = () => {
  if (typeof window === "undefined") return false;
  const { search, pathname } = window.location;
  return pathname.includes("control") || search.includes("panel=true");
};

const truncateTitle = (title: string) =>
  title.length > 20 ? `${title.slice(0, 19).trimEnd()}…` : title;

const computeBarHeight = (level: number, index: number) => {
  // Per-bar phase keeps the stack from moving in lockstep at sustained levels.
  const phase = 0.7 + 0.3 * Math.sin(index * 1.7);
  const scaled = level * 100 * phase;
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
          "bg-card/95 dark:bg-surface-2/95",
          "backdrop-blur-xl",
          "border border-primary/25 dark:border-primary/30",
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
            "hover:bg-primary/8 active:bg-primary/14",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
          )}
        >
          <div className="flex items-end gap-0.75 h-4">
            {Array.from({ length: BAR_COUNT }, (_, i) => (
              <div
                key={i}
                className="w-0.75 rounded-full bg-primary/60 dark:bg-primary/70 origin-bottom"
                style={{ height: computeBarHeight(micLevel, i) }}
              />
            ))}
          </div>
          <span className="text-xs font-medium text-foreground/80 truncate max-w-[12rem]">
            {title}
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
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
            isStopping
              ? "bg-primary/6 text-primary/40 cursor-not-allowed"
              : "bg-primary/10 hover:bg-primary/18 active:bg-primary/25 text-primary"
          )}
        >
          <Square size={12} fill="currentColor" />
        </button>
      </div>
    </div>,
    document.body
  );
}
