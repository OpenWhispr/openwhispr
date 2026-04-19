import { useState, useRef, useCallback, useEffect } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import type { AgentState } from "./types";

interface ChatInputProps {
  agentState: AgentState;
  partialTranscript: string;
  onTextSubmit?: (text: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
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
}: ChatInputProps) {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
    <div className="shrink-0 px-3 pb-3 pt-1">
      <div
        className={cn(
          "flex items-center gap-2 min-h-11 px-3 rounded-lg",
          "bg-surface-1 border border-border/30",
          "transition-colors duration-150",
          isIdle && "focus-within:border-primary/30"
        )}
      >
        {isListening && (
          <>
            <RecordingIndicator />
            <span className="text-[12px] text-foreground/80 truncate flex-1">
              {partialTranscript || t("agentMode.input.listening")}
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

        {(isIdle || isBusy) && (
          <div className="flex items-center gap-2 w-full">
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isBusy}
              autoFocus={autoFocus}
              placeholder={t("agentMode.input.typeMessage")}
              className={cn(
                "input-inline flex-1 outline-none bg-transparent",
                "text-[13px] text-foreground placeholder:text-muted-foreground/40",
                "min-w-0 p-0",
                isBusy && "text-muted-foreground/30 cursor-not-allowed"
              )}
            />
            {isBusy && onCancel ? (
              <button
                onClick={onCancel}
                className={cn(
                  "p-1 rounded-sm shrink-0",
                  "text-muted-foreground/60 hover:text-foreground hover:bg-foreground/8",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-colors duration-100"
                )}
              >
                <Square size={12} className="fill-current" />
              </button>
            ) : isIdle ? (
              <button
                onClick={handleSubmit}
                disabled={!inputText.trim()}
                className={cn(
                  "p-1 rounded-sm shrink-0",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-colors duration-100",
                  inputText.trim()
                    ? "text-primary hover:text-primary/80"
                    : "text-muted-foreground/25 cursor-default"
                )}
              >
                <SendHorizontal size={14} />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
