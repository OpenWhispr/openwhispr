import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import { SendIcon } from "../ui/SendIcon";
import { formatMmSs } from "../../utils/formatDuration";
import { getMicAnalyser, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";

// Brand gradient from the Figma mic/send assets (#5B81E4 → #154BD4 → #163992, top-right to bottom-left)
const GRADIENT_CIRCLE =
  "bg-[linear-gradient(221deg,#5B81E4_0%,#154BD4_55%,#163992_100%)] text-white";

const WAVE_BAR_COUNT = 40;
const WAVE_SAMPLE_MS = 150;
const WAVE_MAX_PX = 20;
const WAVE_MIN_PX = 2;
// Bars scale against a decaying session peak, so any mic gain fills the range.
const WAVE_PEAK_FLOOR = 0.01;
const WAVE_PEAK_DECAY = 0.99;
const WAVE_QUIET_NORM = 0.14;

function waveBarStyle(norm: number, index: number): React.CSSProperties {
  if (norm < WAVE_QUIET_NORM) {
    return { height: WAVE_MIN_PX, backgroundColor: "rgba(143,170,255,0.35)" };
  }
  // Periwinkle (#8FAAFF) → orange (#FFA23E) across the strip, louder = more opaque
  const t = index / (WAVE_BAR_COUNT - 1);
  const r = Math.round(143 + 112 * t);
  const g = Math.round(170 - 8 * t);
  const b = Math.round(255 - 193 * t);
  const alpha = 0.55 + 0.45 * Math.min(1, norm);
  return {
    height: Math.max(WAVE_MIN_PX, Math.round(Math.sqrt(norm) * WAVE_MAX_PX)),
    backgroundColor: `rgba(${r},${g},${b},${alpha})`,
  };
}

function readMicLevel(buf: React.MutableRefObject<Float32Array<ArrayBuffer> | null>): number {
  const analyser = getMicAnalyser();
  if (!analyser) return useMeetingRecordingStore.getState().currentMicLevel;
  if (!buf.current || buf.current.length !== analyser.fftSize) {
    buf.current = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(buf.current);
  let sumSquares = 0;
  for (let i = 0; i < buf.current.length; i++) {
    const v = buf.current[i];
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / buf.current.length);
}

function RecordingWaveform() {
  const [samples, setSamples] = useState<number[]>([]);
  const bufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const peakRef = useRef(WAVE_PEAK_FLOOR);

  useEffect(() => {
    const id = setInterval(() => {
      const level = readMicLevel(bufRef);
      peakRef.current = Math.max(level, peakRef.current * WAVE_PEAK_DECAY, WAVE_PEAK_FLOOR);
      const norm = Math.min(1, level / peakRef.current);
      setSamples((prev) => [...prev.slice(-(WAVE_BAR_COUNT - 1)), norm]);
    }, WAVE_SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  const padded =
    samples.length < WAVE_BAR_COUNT
      ? [...Array<number>(WAVE_BAR_COUNT - samples.length).fill(0), ...samples]
      : samples;

  return (
    <div className="flex items-center gap-0.5 h-5">
      {padded.map((norm, i) => (
        <div
          key={i}
          className="w-0.5 rounded-full shrink-0 transition-[height,background-color] duration-150 ease-out"
          style={waveBarStyle(norm, i)}
        />
      ))}
    </div>
  );
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
              isRecording ? "w-auto" : micHidden ? "w-0" : "w-11",
              !hideInput && !micHidden ? "mr-2" : "mr-0"
            )}
          >
            {isRecording ? (
              <button
                onClick={onStopRecording}
                aria-label={t("notes.editor.stop")}
                title={t("notes.editor.stop")}
                style={{ animation: "scale-in 0.3s cubic-bezier(0.22, 1, 0.36, 1) backwards" }}
                className={cn(
                  "group flex items-center gap-2.5 h-11 pl-0.5 pr-3.5 rounded-full",
                  "bg-white/55 dark:bg-white/6",
                  "backdrop-blur-xl backdrop-saturate-150 transform-gpu",
                  "border border-primary/15 dark:border-primary/25",
                  "shadow-(--shadow-glass)",
                  "transition-all duration-200",
                  "hover:border-primary/30 dark:hover:border-primary/40",
                  "active:scale-[0.99]"
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
                <RecordingWaveform />
                <span className="text-[13px] font-semibold tabular-nums tracking-[0.08em] text-foreground/85 shrink-0">
                  {elapsedLabel}
                </span>
              </button>
            ) : isProcessing ? (
              <div
                className={cn(
                  "flex items-center justify-center w-11 h-11 rounded-full",
                  GRADIENT_CIRCLE
                )}
              >
                <Loader2 size={16} className="animate-spin text-white/90" />
              </div>
            ) : (
              <button
                onClick={onStartRecording}
                disabled={recordingDisabled}
                tabIndex={micHidden ? -1 : undefined}
                className={cn(
                  "flex items-center justify-center w-11 h-11 rounded-full",
                  GRADIENT_CIRCLE,
                  "transition-all duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
                  "hover:brightness-110",
                  "active:scale-95",
                  "disabled:pointer-events-none disabled:opacity-40 disabled:saturate-0",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                  micHidden
                    ? "translate-x-10 opacity-0 pointer-events-none"
                    : "translate-x-0 opacity-100"
                )}
                aria-label={t("notes.editor.transcribe")}
                title={recordingDisabled ? t("common.managedByOrg") : undefined}
              >
                <Mic size={20} />
              </button>
            )}
          </div>
        )}

        <div
          aria-hidden={hideInput}
          className={cn(
            "flex-1 min-w-0 flex items-center h-11 gap-2",
            "rounded-full",
            "bg-white/55 dark:bg-white/6",
            "backdrop-blur-xl backdrop-saturate-150",
            "border shadow-(--shadow-glass) transform-gpu",
            "transition-all duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
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
              style={{ animation: "scale-in 0.15s ease-out backwards" }}
              className={cn(
                "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
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
