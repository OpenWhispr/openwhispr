import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import { SendIcon } from "../ui/SendIcon";
import { LiveWaveform } from "../ui/LiveWaveform";
import { analyserRms } from "../../utils/audioLevel";
import { GRADIENT_CIRCLE } from "../ui/gradientCircle";
import { GLASS_SURFACE } from "../ui/glass";
import { formatMmSs } from "../../utils/formatDuration";
import { getMicAnalyser, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";

// Module-level buffer: there is a single meeting mic analyser at a time.
const micLevelBuf: { current: Float32Array<ArrayBuffer> | null } = { current: null };

// While recording, the bar sits over the live streaming transcript, and every
// partial would force backdrop-blur to re-blur the strip; the capsules trade
// glass for a near-opaque surface until the recording ends.
const RECORDING_SURFACE = "bg-surface-2/95 shadow-(--shadow-glass)";

function readMeetingMicLevel(): number {
  const analyser = getMicAnalyser();
  if (!analyser) return useMeetingRecordingStore.getState().currentMicLevel;
  return analyserRms(analyser, micLevelBuf);
}

interface NoteBottomBarProps {
  isRecording: boolean;
  isProcessing: boolean;
  recordingDisabled?: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onAskSubmit: (text: string) => void;
  onInputFocus?: () => void;
  askDisabled?: boolean;
  actionPicker?: React.ReactNode;
  hideInput?: boolean;
  /** False hides the record control (e.g. read-only shared notes). */
  canRecord?: boolean;
}

export default function NoteBottomBar({
  isRecording,
  isProcessing,
  recordingDisabled = false,
  onStartRecording,
  onStopRecording,
  onAskSubmit,
  onInputFocus,
  askDisabled,
  actionPicker,
  hideInput,
  canRecord = true,
}: NoteBottomBarProps) {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);
  const [wasRecording, setWasRecording] = useState(isRecording);

  if (isRecording !== wasRecording) {
    setWasRecording(isRecording);
    if (!isRecording) setElapsed(0);
  }

  useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  const elapsedLabel = formatMmSs(elapsed);

  const hasText = inputText.trim().length > 0;

  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text || askDisabled) return;
    onAskSubmit(text);
    setInputText("");
    setIsExpanded(false);
  }, [inputText, askDisabled, onAskSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape") {
        setIsExpanded(false);
        inputRef.current?.blur();
      }
    },
    [handleSubmit]
  );

  const handleInputFocus = useCallback(() => {
    setIsExpanded(true);
    onInputFocus?.();
  }, [onInputFocus]);

  const micHidden = !hideInput && isExpanded && !isRecording;

  // Chat panel opening hides the input; drop the expanded state so the bar
  // comes back in its idle layout (mic visible) when the panel closes.
  useEffect(() => {
    if (hideInput) setIsExpanded(false);
  }, [hideInput]);

  useEffect(() => {
    if (!isExpanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (!hasText && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsExpanded(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded, hasText]);

  return (
    <div
      ref={containerRef}
      className="absolute bottom-0 left-0 right-0 z-10 px-5 pb-4 pt-6 pointer-events-none bg-gradient-to-t from-background from-45% to-transparent"
    >
      <div className="flex items-end pointer-events-auto w-full max-w-[600px] mx-auto">
        {canRecord && (
          <div
            className={cn(
              "shrink-0 overflow-hidden",
              "transition-all duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
              isRecording ? "w-[284px]" : micHidden ? "w-0" : "w-11",
              !hideInput && !micHidden ? "mr-2" : "mr-0"
            )}
          >
            {isRecording ? (
              <button
                onClick={onStopRecording}
                aria-label={t("notes.editor.stop")}
                title={t("notes.editor.stop")}
                className={cn(
                  "group flex items-center gap-2.5 w-full h-11 pl-0.5 pr-3.5 rounded-full",
                  RECORDING_SURFACE,
                  "border border-primary/15 dark:border-primary/25",
                  "transition-[border-color] duration-200",
                  "hover:border-primary/30 dark:hover:border-primary/40"
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center w-8 h-8 rounded-full shrink-0",
                    GRADIENT_CIRCLE,
                    "transition-[filter] duration-150 group-hover:brightness-110"
                  )}
                >
                  <Square size={11} fill="currentColor" />
                </span>
                <LiveWaveform readLevel={readMeetingMicLevel} />
                <span className="text-[13px] font-semibold tabular-nums tracking-[0.08em] text-foreground/85 shrink-0">
                  {elapsedLabel}
                </span>
              </button>
            ) : (
              <button
                onClick={onStartRecording}
                disabled={recordingDisabled || isProcessing}
                tabIndex={micHidden ? -1 : undefined}
                className={cn(
                  "flex items-center justify-center w-11 h-11 rounded-full",
                  GRADIENT_CIRCLE,
                  "transition-all duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
                  "hover:brightness-110",
                  "active:scale-95",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                  recordingDisabled && "opacity-40 saturate-0 pointer-events-none",
                  isProcessing && "pointer-events-none",
                  micHidden
                    ? "translate-x-10 opacity-0 pointer-events-none"
                    : "translate-x-0 opacity-100"
                )}
                aria-label={t("notes.editor.transcribe")}
                title={recordingDisabled ? t("common.managedByOrg") : undefined}
              >
                {isProcessing ? (
                  <Loader2 size={16} className="animate-spin text-white/90" />
                ) : (
                  <Mic size={20} />
                )}
              </button>
            )}
          </div>
        )}

        <div
          aria-hidden={hideInput}
          className={cn(
            "flex-1 min-w-0 flex items-center h-11 gap-2 rounded-full",
            isRecording ? RECORDING_SURFACE : GLASS_SURFACE,
            "border",
            // Named properties, not transition-all: the surface swap below must
            // land instantly, or every recording start/stop tweens
            // backdrop-filter for 500ms — the exact cost being removed.
            "transition-[max-width,opacity,padding,border-color,box-shadow] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
            hideInput
              ? "max-w-0 opacity-0 pl-0 pr-0 border-transparent shadow-none pointer-events-none"
              : "max-w-[600px] opacity-100 pl-4 pr-1.5",
            isExpanded
              ? "border-black/15 dark:border-white/22 ring-[3px] ring-primary/8"
              : !hideInput && "border-black/10 dark:border-white/14"
          )}
        >
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={handleInputFocus}
            disabled={askDisabled}
            tabIndex={hideInput ? -1 : undefined}
            placeholder={t("embeddedChat.askPlaceholder")}
            className={cn(
              "input-inline flex-1 bg-transparent outline-none min-w-0 p-0 caret-primary",
              "text-[13px] text-foreground",
              "placeholder:text-foreground/25 dark:placeholder:text-foreground/15"
            )}
          />

          {hasText ? (
            <button
              onClick={handleSubmit}
              disabled={askDisabled}
              className={cn(
                "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                "animate-[scale-in_0.15s_ease-out_backwards]",
                "transition-all duration-150",
                "hover:brightness-110",
                "active:scale-90",
                "disabled:opacity-30"
              )}
              aria-label={t("embeddedChat.send")}
            >
              <SendIcon size={28} className="block" />
            </button>
          ) : !isExpanded ? (
            <div className="shrink-0">{actionPicker}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
