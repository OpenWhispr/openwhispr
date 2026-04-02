import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Mic, ArrowUp, Square, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

const BAR_COUNT = 5;

interface NoteBottomBarProps {
  isRecording: boolean;
  isProcessing: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onAskSubmit: (text: string) => void;
  askDisabled?: boolean;
  actionPicker?: React.ReactNode;
}

export default function NoteBottomBar({
  isRecording,
  isProcessing,
  onStartRecording,
  onStopRecording,
  onAskSubmit,
  askDisabled,
  actionPicker,
}: NoteBottomBarProps) {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRecording) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");

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
  }, []);

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
      className="absolute bottom-0 left-0 right-0 z-10 px-5 pb-4 pointer-events-none"
    >
      <div className="flex items-end gap-2 pointer-events-auto">
        <div
          className={cn(
            "shrink-0 transition-all duration-300 ease-out overflow-hidden",
            isExpanded && !isRecording ? "w-0 opacity-0" : "w-auto opacity-100"
          )}
        >
          {isRecording ? (
            <button
              onClick={onStopRecording}
              className={cn(
                "flex items-center gap-2 h-10 pl-3.5 pr-3 rounded-xl",
                "bg-primary/6 dark:bg-primary/10",
                "border border-primary/20 dark:border-primary/25",
                "backdrop-blur-sm",
                "transition-colors duration-150",
                "hover:bg-primary/10 dark:hover:bg-primary/15"
              )}
            >
              <div className="flex items-end gap-0.5 h-3.5">
                {Array.from({ length: BAR_COUNT }, (_, i) => (
                  <div
                    key={i}
                    className="w-0.5 rounded-full bg-primary/60 dark:bg-primary/70 origin-bottom"
                    style={{
                      height: "100%",
                      animation: `waveform-bar ${0.5 + i * 0.07}s ease-in-out infinite`,
                      animationDelay: `${i * 0.04}s`,
                    }}
                  />
                ))}
              </div>
              <span className="text-[11px] font-medium tabular-nums text-primary/60 dark:text-primary/70">
                {minutes}:{seconds}
              </span>
              <Square size={9} fill="currentColor" className="text-primary/50" />
            </button>
          ) : isProcessing ? (
            <div
              className={cn(
                "flex items-center justify-center w-10 h-10 rounded-xl",
                "bg-foreground/3 dark:bg-white/4",
                "border border-border/20 dark:border-white/6"
              )}
            >
              <Loader2 size={14} className="animate-spin text-foreground/25" />
            </div>
          ) : (
            <button
              onClick={onStartRecording}
              className={cn(
                "flex items-center justify-center w-10 h-10 rounded-xl",
                "bg-foreground/3 dark:bg-white/4",
                "border border-border/20 dark:border-white/6",
                "backdrop-blur-sm",
                "text-foreground/30 dark:text-foreground/20",
                "transition-all duration-200",
                "hover:bg-foreground/6 dark:hover:bg-white/8",
                "hover:text-foreground/50 dark:hover:text-foreground/35",
                "hover:border-border/30 dark:hover:border-white/10",
                "active:scale-95"
              )}
              aria-label={t("notes.editor.transcribe")}
            >
              <Mic size={15} />
            </button>
          )}
        </div>

        <div
          className={cn(
            "flex-1 min-w-0 flex items-center h-10 px-3 gap-2",
            "rounded-xl",
            "bg-foreground/3 dark:bg-white/4",
            "border",
            "transition-all duration-200",
            isExpanded
              ? "border-foreground/12 dark:border-white/10 shadow-[0_0_0_3px_rgba(0,0,0,0.02)] dark:shadow-[0_0_0_3px_rgba(255,255,255,0.02)]"
              : "border-border/20 dark:border-white/6"
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
            placeholder={t("embeddedChat.askPlaceholder")}
            className={cn(
              "input-inline flex-1 bg-transparent outline-none min-w-0 p-0",
              "text-[13px] text-foreground",
              "placeholder:text-foreground/25 dark:placeholder:text-foreground/15"
            )}
          />

          {hasText ? (
            <button
              onClick={handleSubmit}
              disabled={askDisabled}
              className={cn(
                "flex items-center justify-center w-6 h-6 rounded-md shrink-0",
                "bg-foreground dark:bg-foreground/90 text-background",
                "transition-all duration-150",
                "hover:bg-foreground/85 dark:hover:bg-foreground/80",
                "active:scale-90",
                "disabled:opacity-30"
              )}
              aria-label={t("embeddedChat.send")}
            >
              <ArrowUp size={13} strokeWidth={2.5} />
            </button>
          ) : !isExpanded ? (
            <div className="shrink-0">{actionPicker}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
