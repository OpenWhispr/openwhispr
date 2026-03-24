import { useState, useRef, useCallback } from "react";
import { Mic, SendHorizontal, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatHotkeyLabel, isGlobeLikeHotkey } from "../../utils/hotkeys";
import type { AgentState } from "./types";
import { toolIcons } from "./toolIcons";

interface ChatInputProps {
  agentState: AgentState;
  partialTranscript: string;
  toolStatus?: string;
  activeToolName?: string;
  onTextSubmit?: (text: string) => void;
  onCancel?: () => void;
  showHotkey?: boolean;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center",
        "min-w-5 h-4.5 px-1.5",
        "text-[10px] font-medium leading-none",
        "text-muted-foreground/70",
        "bg-foreground/6 border border-foreground/8",
        "rounded-sm",
        "shadow-[0_1px_0_0_rgba(0,0,0,0.04)]"
      )}
    >
      {children}
    </kbd>
  );
}

function HotkeyKeys({ hotkey }: { hotkey: string }) {
  const label = formatHotkeyLabel(hotkey);

  if (isGlobeLikeHotkey(hotkey) || !label.includes("+")) {
    return <Kbd>{label}</Kbd>;
  }

  const parts = label.split("+");

  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <Kbd key={i}>{part}</Kbd>
      ))}
    </span>
  );
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
  toolStatus,
  activeToolName,
  onTextSubmit,
  onCancel,
  showHotkey = false,
}: ChatInputProps) {
  const { t } = useTranslation();
  const agentKey = useSettingsStore((s) => s.agentKey);
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text || !onTextSubmit) return;
    onTextSubmit(text);
    setInputText("");
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
  const isBusy = agentState === "thinking" || agentState === "streaming" || agentState === "tool-executing";
  const ToolIcon = activeToolName ? toolIcons[activeToolName] : null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 h-10 px-3 shrink-0",
        "bg-surface-1 border-t border-border/30"
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
        <div className="relative flex items-center gap-2 w-full">
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isBusy}
            placeholder={isBusy ? "" : t("agentMode.input.typeMessage")}
            className={cn(
              "input-inline flex-1 outline-none bg-transparent",
              "text-[13px] text-foreground placeholder:text-muted-foreground/40",
              "min-w-0 p-0",
              isBusy && "opacity-0 pointer-events-none"
            )}
          />
          {isBusy && (
            <div className="absolute inset-0 flex items-center gap-2 pr-8 pointer-events-none">
              {agentState === "tool-executing" && ToolIcon ? (
                <ToolIcon size={12} className="text-primary/60 shrink-0" />
              ) : null}
              <span className="text-[12px] text-muted-foreground/60 select-none truncate">
                {agentState === "tool-executing" && toolStatus
                  ? toolStatus
                  : t("agentMode.input.thinking")}
              </span>
            </div>
          )}
          {isIdle && inputText.trim() ? (
            <button
              onClick={handleSubmit}
              className={cn(
                "p-1 rounded-sm shrink-0",
                "text-primary hover:text-primary/80",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                "transition-colors duration-100"
              )}
            >
              <SendHorizontal size={14} />
            </button>
          ) : isBusy && onCancel ? (
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
          ) : isIdle && showHotkey ? (
            <div className="flex items-center gap-2 shrink-0">
              <div
                className="text-muted-foreground/50"
                style={{ animation: "agent-mic-pulse 2.5s ease-in-out infinite" }}
              >
                <Mic size={14} />
              </div>
              <HotkeyKeys hotkey={agentKey} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
