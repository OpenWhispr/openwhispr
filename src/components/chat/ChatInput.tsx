import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { ArrowRight, Mic, Square, X } from "../icons";
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
  variant?: "default" | "assistant" | "note" | "sidebar";
  outlined?: boolean;
  draftText?: string;
  onDraftChange?: (text: string) => void;
  onFocus?: () => void;
  onEscape?: () => void;
  trailingContent?: React.ReactNode;
  focusOnIdle?: boolean;
  expandOnFocus?: boolean;
  expandOnFocusSize?: "standard" | "compact";
  disabled?: boolean;
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
  variant = "default",
  outlined = false,
  draftText,
  onDraftChange,
  onFocus,
  onEscape,
  trailingContent,
  focusOnIdle = true,
  expandOnFocus = false,
  expandOnFocusSize = "standard",
  disabled = false,
}: ChatInputProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [localDraft, setLocalDraft] = useState("");
  const inputText = draftText ?? localDraft;
  const setInputText = onDraftChange ?? setLocalDraft;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const allowDeferredFocusRef = useRef(variant !== "note" || focusOnIdle);
  allowDeferredFocusRef.current = variant !== "note" || focusOnIdle;
  const focusAfterFrame = useCallback(() => {
    requestAnimationFrame(() => {
      if (allowDeferredFocusRef.current) inputRef.current?.focus();
    });
  }, []);

  const voice = useVoiceDraft({
    onTranscript: (text) => {
      setInputText(inputText.trim() ? `${inputText.trim()} ${text}` : text);
      focusAfterFrame();
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
    if (!text || !onTextSubmit || disabled) return;
    onTextSubmit(text);
    setInputText("");
    focusAfterFrame();
  }, [inputText, onTextSubmit, setInputText, disabled, focusAfterFrame]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape" && onEscape) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.blur();
        onEscape();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, onEscape]
  );

  const isIdle = agentState === "idle";
  const isListening = agentState === "listening";
  const isTranscribing = agentState === "transcribing";
  const isBusy =
    agentState === "thinking" || agentState === "streaming" || agentState === "tool-executing";

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (expandOnFocus || variant === "sidebar") {
      input.style.height = "100%";
    } else {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    }
  }, [inputText, isVoiceRecording, isVoiceTranscribing, expandOnFocus, variant]);

  useEffect(() => {
    if (!isIdle || !focusOnIdle) return;
    const frameId = requestAnimationFrame(() => {
      if (allowDeferredFocusRef.current) inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [isIdle, focusOnIdle]);

  return (
    <div className={cn("shrink-0", className ?? "px-3 pb-3 pt-1")}>
      <div
        className={cn(
          "flex items-center gap-2 min-h-11",
          variant === "sidebar"
            ? "h-14 items-end rounded-3xl bg-background ps-4 pe-2 py-1.5 focus-within:h-40 dark:bg-surface-2"
            : "rounded-3xl ps-4 pe-1.5 py-1.5",
          variant === "assistant"
            ? "min-h-12 bg-card shadow-sm dark:bg-surface-2"
            : variant === "note"
              ? outlined
                ? "min-h-12 bg-background"
                : "min-h-12 bg-transparent"
              : variant === "default" && GLASS_SURFACE,
          variant === "sidebar"
            ? "border border-border/80 dark:border-white/14"
            : variant === "note"
              ? outlined
                ? "border border-border/70 dark:border-white/14"
                : "border-0"
              : "border border-black/10 dark:border-white/14",
          variant === "sidebar"
            ? "transition-[height,border-color,box-shadow] duration-300 ease-out motion-reduce:transition-none"
            : expandOnFocus
              ? cn(
                  "h-12 items-end transition-[height,border-color,box-shadow] duration-300 ease-out motion-reduce:transition-none",
                  expandOnFocusSize === "compact"
                    ? "focus-within:h-[min(36vh,14rem)]"
                    : "focus-within:h-[min(40vh,16rem)]"
                )
              : "transition-[border-color,box-shadow] duration-200",
          isIdle &&
            (variant === "assistant"
              ? "focus-within:border-foreground/15 focus-within:ring-2 focus-within:ring-foreground/5"
              : variant === "note"
                ? ""
                : "focus-within:border-black/15 dark:focus-within:border-white/22 focus-within:ring-[3px] focus-within:ring-primary/8")
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
                "text-muted-foreground/70 hover:text-foreground hover:bg-foreground/8",
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
          <div
            className={cn(
              "flex items-end gap-2 w-full",
              (expandOnFocus || variant === "sidebar") && "h-full"
            )}
          >
            <textarea
              dir="auto"
              ref={inputRef}
              rows={1}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={onFocus}
              disabled={isBusy || disabled}
              autoFocus={autoFocus}
              placeholder={placeholder ?? t("agentMode.input.typeMessage")}
              className={cn(
                "input-inline flex-1 outline-none bg-transparent caret-primary",
                variant === "default" ? "text-[13px]" : "text-sm",
                "text-foreground placeholder:text-muted-foreground/70",
                "min-w-0 min-h-8 max-h-32 resize-none overflow-y-auto border-0 px-0 py-1.5 leading-5",
                (expandOnFocus || variant === "sidebar") && "min-h-0 max-h-none",
                (isBusy || disabled) && "text-muted-foreground/70 cursor-not-allowed"
              )}
            />
            {isIdle && !inputText.trim() && trailingContent}
            {isBusy && onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                aria-label={t("common.cancel")}
                title={t("common.cancel")}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                  "text-muted-foreground/70 hover:text-foreground hover:bg-foreground/8",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-colors duration-100"
                )}
              >
                <Square size={12} className="fill-current" />
              </button>
            ) : isIdle && (inputText.trim() || !voiceDraft) ? (
              <button
                onClick={handleSubmit}
                disabled={!inputText.trim() || disabled}
                aria-label={t("agentMode.input.send")}
                className={cn(
                  "rounded-full shrink-0",
                  voiceDraft && "animate-[scale-in_0.15s_ease-out_backwards]",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-all duration-100",
                  inputText.trim()
                    ? "hover:brightness-110 active:scale-95"
                    : variant === "assistant" || variant === "note" || variant === "sidebar"
                      ? "cursor-default"
                      : "opacity-30 saturate-0 cursor-default"
                )}
              >
                {variant === "assistant" || variant === "note" || variant === "sidebar" ? (
                  <span className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <ArrowRight size={18} className="-rotate-90" />
                  </span>
                ) : (
                  <SendIcon size={28} className="block rtl:scale-x-[-1]" />
                )}
              </button>
            ) : isIdle ? (
              <button
                onClick={voice.start}
                disabled={voice.streamingOnlyProvider || disabled}
                aria-label={t("notes.editor.transcribe")}
                title={
                  voice.streamingOnlyProvider || disabled
                    ? t("agentMode.input.voiceDraftStreamingOnly")
                    : t("notes.editor.transcribe")
                }
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                  GRADIENT_CIRCLE,
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-all duration-100",
                  voice.streamingOnlyProvider
                    ? "opacity-30 saturate-0 cursor-default"
                    : "hover:brightness-110 active:scale-95"
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
