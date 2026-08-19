import { useState, useRef, useCallback, useEffect } from "react";
import { Mic, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { SendIcon } from "../ui/SendIcon";
import { LiveWaveform } from "../ui/LiveWaveform";
import { GRADIENT_CIRCLE } from "../ui/gradientCircle";
import { GLASS_SURFACE } from "../ui/glass";
import { useToast } from "../ui/useToast";
import { formatMmSs } from "../../utils/formatDuration";
import { useVoiceDraft } from "./useVoiceDraft";
import type { AgentState } from "./types";

interface ChatInputProps {
  agentState: AgentState;
  partialTranscript: string;
  onTextSubmit?: (text: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** Overrides the default wrapper padding (compact hosts like the assistant panel). */
  className?: string;
  /** Offer a mic when the input is empty; recordings transcribe into the input. */
  voiceDraft?: boolean;
}

function RecordingIndicator() {
  return (
    <div className="relative flex items-center justify-center w-5 h-5 shrink-0">
      <div className="absolute inset-0 rounded-full border-2 border-primary/40 animate-pulse" />
      <div className="w-2.5 h-2.5 rounded-full bg-primary" />
    </div>
  );
}

function ProcessingIndicator() {
  return (
    <div className="flex items-center justify-center w-5 h-5 shrink-0">
      <div className="flex items-center gap-0.5">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="w-0.5 bg-accent rounded-full"
            style={{
              height: "8px",
              animation: `waveform-bar 0.6s ease-in-out ${i * 0.1}s infinite`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function ChatInput({
  agentState,
  partialTranscript,
  onTextSubmit,
  onCancel,
  autoFocus = false,
  placeholder,
  className,
  voiceDraft = false,
}: ChatInputProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const voice = useVoiceDraft({
    onTranscript: (text) => {
      setInputText((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    onError: (message) => {
      toast({
        title: t("notes.upload.transcriptionFailed"),
        description: message || undefined,
        variant: "destructive",
      });
    },
  });
  const isVoiceRecording = voice.status === "recording";
  const isVoiceTranscribing = voice.status === "transcribing";

  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text || !onTextSubmit) return;
    onTextSubmit(text);
    setInputText("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [inputText, onTextSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const isIdle = agentState === "idle";
  const isListening = agentState === "listening";
  const isTranscribing = agentState === "transcribing";
  const isBusy =
    agentState === "thinking" || agentState === "streaming" || agentState === "tool-executing";

  useEffect(() => {
    if (isIdle) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isIdle]);

  return (
    <div className={cn("shrink-0", className ?? "px-3 pb-3 pt-1")}>
      <div
        className={cn(
          "flex items-center gap-2 min-h-11 pl-4 pr-1.5 rounded-full",
          GLASS_SURFACE,
          "border border-black/10 dark:border-white/14",
          "transition-all duration-200",
          isIdle &&
            "focus-within:border-black/15 dark:focus-within:border-white/22 focus-within:ring-[3px] focus-within:ring-primary/8"
        )}
      >
        {isListening && (
          <>
            <RecordingIndicator />
            <span className="text-[12px] text-foreground/80 truncate flex-1">
              {/* A live transcript's informative part is its tail — show the
                  latest words once the line fills instead of a frozen start. */}
              {partialTranscript.length > 60
                ? `…${partialTranscript.slice(-60)}`
                : partialTranscript || t("agentMode.input.listening")}
            </span>
          </>
        )}

        {isTranscribing && (
          <>
            <ProcessingIndicator />
            <span className="text-[12px] text-muted-foreground select-none">
              {t("agentMode.input.transcribing")}
            </span>
          </>
        )}

        {isVoiceRecording && (
          <div className="flex items-center gap-2.5 w-full py-1.5 animate-[fade-in-content_0.3s_ease-out_backwards]">
            <LiveWaveform
              readLevel={voice.readLevel}
              bars="auto"
              className="flex-1 overflow-hidden"
            />
            <span className="text-[13px] font-semibold tabular-nums tracking-[0.08em] text-foreground/85 shrink-0">
              {formatMmSs(voice.elapsed)}
            </span>
            <button
              onClick={voice.cancel}
              aria-label={t("common.cancel")}
              title={t("common.cancel")}
              className={cn(
                "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                "text-muted-foreground/60 hover:text-foreground hover:bg-foreground/8",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                "transition-colors duration-100"
              )}
            >
              <X size={14} />
            </button>
            <button
              onClick={voice.stop}
              aria-label={t("notes.editor.stop")}
              title={t("notes.editor.stop")}
              className={cn(
                "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                "animate-[scale-in_0.15s_ease-out_backwards]",
                GRADIENT_CIRCLE,
                "hover:brightness-110 active:scale-95",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                "transition-all duration-100"
              )}
            >
              <Square size={10} fill="currentColor" />
            </button>
          </div>
        )}

        {isVoiceTranscribing && (
          <>
            <ProcessingIndicator />
            <span className="text-[12px] text-muted-foreground select-none">
              {t("agentMode.input.transcribing")}
            </span>
          </>
        )}

        {(isIdle || isBusy) && !isVoiceRecording && !isVoiceTranscribing && (
          <div className="flex items-center gap-2 w-full">
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isBusy}
              autoFocus={autoFocus}
              placeholder={placeholder ?? t("agentMode.input.typeMessage")}
              className={cn(
                "input-inline flex-1 outline-none bg-transparent caret-primary",
                "text-[13px] text-foreground placeholder:text-muted-foreground/40",
                "min-w-0 p-0",
                isBusy && "text-muted-foreground/30 cursor-not-allowed"
              )}
            />
            {isBusy && onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                aria-label={t("common.cancel")}
                title={t("common.cancel")}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                  "text-muted-foreground/60 hover:text-foreground hover:bg-foreground/8",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-colors duration-100"
                )}
              >
                <Square size={12} className="fill-current" />
              </button>
            ) : isIdle && (inputText.trim() || !voiceDraft) ? (
              <button
                onClick={handleSubmit}
                disabled={!inputText.trim()}
                aria-label={t("agentMode.input.send")}
                className={cn(
                  "rounded-full shrink-0",
                  voiceDraft && "animate-[scale-in_0.15s_ease-out_backwards]",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-all duration-100",
                  inputText.trim()
                    ? "hover:brightness-110 active:scale-95"
                    : "opacity-30 saturate-0 cursor-default"
                )}
              >
                <SendIcon size={28} className="block" />
              </button>
            ) : isIdle ? (
              <button
                onClick={voice.start}
                aria-label={t("notes.editor.transcribe")}
                title={t("notes.editor.transcribe")}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                  GRADIENT_CIRCLE,
                  "hover:brightness-110 active:scale-95",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-all duration-100"
                )}
              >
                <Mic size={14} />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
