import { useTranslation } from "react-i18next";
import { Mic, MicOff } from "../icons";
import { cn } from "../lib/utils";
import { setMicMuted, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";

/** Mutes the live recording's microphone while system audio keeps being transcribed. */
export default function MicMuteButton() {
  const { t } = useTranslation();
  const micMuted = useMeetingRecordingStore((s) => s.micMuted);
  // "inactive" means no mic was opened (it failed, or the recording is still
  // starting), so there is nothing to mute yet.
  const hasMic = useMeetingRecordingStore((s) => s.micCaptureStatus !== "inactive");
  const label = t(micMuted ? "notes.editor.unmuteMic" : "notes.editor.muteMic");

  if (!hasMic && !micMuted) return null;

  return (
    <button
      type="button"
      onClick={() => setMicMuted(!micMuted)}
      aria-pressed={micMuted}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border",
        "transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
        micMuted
          ? "border-amber-500/40 bg-amber-500/12 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
          : "border-primary/15 bg-surface-2/95 text-foreground/70 hover:border-primary/30 hover:text-foreground dark:border-primary/25"
      )}
    >
      {micMuted ? <MicOff size={14} /> : <Mic size={14} />}
    </button>
  );
}
