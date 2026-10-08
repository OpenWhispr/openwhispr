import { useState, useRef, useCallback, useEffect, useLayoutEffect, useId, useMemo } from "react";
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
import SlashCommandMenu from "./SlashCommandMenu";
import { matchSlashCommands, slashOptionId, type SlashCommand } from "./slashCommands";
import type { AgentState } from "./types";

// Controls stay bottom-anchored so they hold the corner while the composer expands;
// this lifts a 28px control to the center of the collapsed composer's 34px row.
const COLLAPSED_ROW_CENTER = "mb-[3px]";

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
  /** Shown instead of the send or mic button while idle. */
  trailingContent?: React.ReactNode;
  focusOnIdle?: boolean;
  expandOnFocus?: boolean;
  expandOnFocusSize?: "standard" | "compact";
  /** Offered in a menu while the draft is "/" plus an optional filter. */
  slashCommands?: SlashCommand[];
  /** The menu fills the host above the composer, so the host hides what it would cover. */
  onSlashMenuOpenChange?: (open: boolean) => void;
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
  slashCommands,
  onSlashMenuOpenChange,
}: ChatInputProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [localDraft, setLocalDraft] = useState("");
  const inputText = draftText ?? localDraft;
  const setInputText = onDraftChange ?? setLocalDraft;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
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
  const isCompactNote = variant === "note" && !outlined;
  // These variants send with a 32px circle; the mic takes the same circle so the two swap in place.
  const hasRoundSend = variant === "assistant" || variant === "note" || variant === "sidebar";
  // These composers are 48px tall at rest with bottom-anchored controls, which these margins
  // center on the first line: the outlined note composer, and the docked one until it expands.
  const centersFirstLine = outlined || variant === "sidebar";
  const rowCenter = centersFirstLine && "mb-0.5";

  const isIdle = agentState === "idle";
  const isListening = agentState === "listening";
  const isTranscribing = agentState === "transcribing";
  const isBusy =
    agentState === "thinking" || agentState === "streaming" || agentState === "tool-executing";

  const slashMenuId = useId();
  const [isFocused, setIsFocused] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMatches = useMemo(
    () =>
      slashCommands && isFocused && isIdle ? matchSlashCommands(slashCommands, inputText) : [],
    [slashCommands, isFocused, isIdle, inputText]
  );
  const activeSlashIndex = Math.min(slashIndex, slashMatches.length - 1);
  const isSlashMenuOpen = slashMatches.length > 0;

  useLayoutEffect(() => {
    onSlashMenuOpenChange?.(isSlashMenuOpen);
  }, [isSlashMenuOpen, onSlashMenuOpenChange]);

  const runSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.disabled) return;
      setInputText("");
      command.run();
    },
    [setInputText]
  );

  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text || !onTextSubmit || isBusy) return;
    // Cleared first, so a host that can't send yet can write the draft back.
    setInputText("");
    onTextSubmit(text);
    focusAfterFrame();
  }, [inputText, onTextSubmit, setInputText, isBusy, focusAfterFrame]);

  // The Cancel button unmounts once the reply stops, which would drop its focus to the page.
  const handleCancel = useCallback(() => {
    onCancel?.();
    focusAfterFrame();
  }, [onCancel, focusAfterFrame]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isSlashMenuOpen && !e.nativeEvent.isComposing) {
        const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        if (step !== 0) {
          e.preventDefault();
          setSlashIndex((activeSlashIndex + step + slashMatches.length) % slashMatches.length);
          return;
        }
        const command = slashMatches[activeSlashIndex];
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          runSlashCommand(command);
          return;
        }
        // Tab runs like Enter, but lets focus move on past a command that can't run.
        if (e.key === "Tab" && !e.shiftKey && !command.disabled) {
          e.preventDefault();
          runSlashCommand(command);
          return;
        }
        // Dismiss the menu, not the composer.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setInputText("");
          return;
        }
      }
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
    [
      handleSubmit,
      onEscape,
      isSlashMenuOpen,
      slashMatches,
      activeSlashIndex,
      runSlashCommand,
      setInputText,
    ]
  );

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const composer = composerRef.current;
    if (expandOnFocus && composer) {
      // The focused composer opens at half its maximum height and grows with the
      // draft up to that maximum (see --composer-fit-height below).
      input.style.height = "100%";
      const chromeHeight = composer.offsetHeight - input.offsetHeight;
      input.style.height = "auto";
      const draftHeight = input.scrollHeight;
      input.style.height = "100%";
      composer.style.setProperty("--composer-fit-height", `${draftHeight + chromeHeight}px`);
    } else if (variant === "sidebar" || isCompactNote) {
      input.style.height = "100%";
    } else {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    }
  }, [inputText, isVoiceRecording, isVoiceTranscribing, expandOnFocus, variant, isCompactNote]);

  useEffect(() => {
    if (!isIdle || !focusOnIdle) return;
    const frameId = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frameId);
  }, [isIdle, focusOnIdle]);

  return (
    <div
      className={cn(
        isSlashMenuOpen ? "flex min-h-0 flex-1 flex-col" : "shrink-0",
        className ?? "px-3 pb-3 pt-1"
      )}
    >
      {isSlashMenuOpen && (
        <SlashCommandMenu
          id={slashMenuId}
          label={t("agentMode.input.commands")}
          commands={slashMatches}
          activeIndex={activeSlashIndex}
          onActiveIndexChange={setSlashIndex}
          onRun={runSlashCommand}
        />
      )}
      <div
        ref={composerRef}
        className={cn(
          "flex items-center gap-2 min-h-11",
          variant === "sidebar"
            ? "h-12 items-end rounded-2xl bg-background ps-3.5 pe-2 py-1.5 focus-within:h-40 dark:bg-surface-1"
            : "rounded-3xl ps-4 pe-1.5 py-1.5",
          isCompactNote && "h-12 overflow-hidden",
          variant === "assistant"
            ? "min-h-12 bg-card shadow-sm dark:bg-surface-2"
            : variant === "note"
              ? outlined
                ? "min-h-12 bg-white/55 dark:bg-white/[0.035]"
                : "min-h-12 bg-transparent"
              : variant === "default" && GLASS_SURFACE,
          // The outlined note composer draws an inset ring, which takes no room and sits where
          // the bar's outline was, so nothing in it moves as the chat opens.
          variant === "sidebar"
            ? "border border-black/[0.08] dark:border-white/[0.08]"
            : variant === "note"
              ? outlined
                ? "border-0 ring-1 ring-inset ring-primary/20 focus-within:ring-primary/45 dark:ring-primary/25 dark:focus-within:ring-primary/50"
                : "border-0"
              : "border border-black/10 dark:border-white/14",
          variant === "sidebar"
            ? "transition-[height,border-color,box-shadow] duration-300 ease-out motion-reduce:transition-none"
            : expandOnFocus
              ? cn(
                  "h-12 items-end pe-2.25 transition-[height,border-color,box-shadow] duration-300 ease-out motion-reduce:transition-none",
                  expandOnFocusSize === "compact"
                    ? "focus-within:h-[clamp(min(18vh,7rem),var(--composer-fit-height,0px),min(36vh,14rem))]"
                    : "focus-within:h-[clamp(min(20vh,8rem),var(--composer-fit-height,0px),min(40vh,16rem))]"
                )
              : "transition-[border-color,box-shadow,background-color] duration-200",
          isIdle &&
            (variant === "assistant"
              ? "focus-within:border-foreground/15 focus-within:ring-2 focus-within:ring-foreground/5"
              : variant === "note"
                ? ""
                : variant === "sidebar"
                  ? // The tray around it already frames it; a ring would read as a second border.
                    "focus-within:border-black/15 dark:focus-within:border-white/15"
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
              "flex gap-2 w-full",
              isCompactNote ? "items-center" : "items-end",
              (expandOnFocus || variant === "sidebar" || isCompactNote) && "h-full"
            )}
          >
            <textarea
              dir="auto"
              ref={inputRef}
              rows={1}
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                setSlashIndex(0);
              }}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                setIsFocused(true);
                setSlashIndex(0);
                onFocus?.();
              }}
              onBlur={() => setIsFocused(false)}
              aria-autocomplete={slashCommands ? "list" : undefined}
              aria-controls={isSlashMenuOpen ? slashMenuId : undefined}
              aria-activedescendant={
                isSlashMenuOpen ? slashOptionId(slashMenuId, activeSlashIndex) : undefined
              }
              // Read-only, not disabled: disabling would drop focus for the length of every reply.
              readOnly={isBusy}
              autoFocus={autoFocus}
              placeholder={placeholder ?? t("agentMode.input.typeMessage")}
              className={cn(
                "input-inline flex-1 outline-none bg-transparent caret-primary",
                variant === "default" ? "text-[13px]" : "text-sm",
                "text-foreground placeholder:text-muted-foreground/70",
                "min-w-0 min-h-8 max-h-32 resize-none overflow-y-auto border-0 px-0 py-1.5 leading-5",
                // One line fills the 36px row, as the bare note composer's does.
                outlined && "min-h-9",
                (expandOnFocus || variant === "sidebar" || isCompactNote) && "min-h-0 max-h-none",
                isBusy && "text-muted-foreground/70 cursor-not-allowed"
              )}
            />
            {isBusy && onCancel ? (
              <button
                type="button"
                onClick={handleCancel}
                aria-label={t("common.cancel")}
                title={t("common.cancel")}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                  expandOnFocus && COLLAPSED_ROW_CENTER,
                  // The 28px stop's share of the same centering.
                  centersFirstLine && "mb-1",
                  "text-muted-foreground/70 hover:text-foreground hover:bg-foreground/8",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-colors duration-100"
                )}
              >
                <Square size={12} className="fill-current" />
              </button>
            ) : isIdle && trailingContent ? (
              trailingContent
            ) : isIdle && (inputText.trim() || !voiceDraft) ? (
              // Keyed apart from the mic, so each swap mounts a new button and replays its pop-in.
              <button
                key="send"
                onClick={handleSubmit}
                disabled={!inputText.trim()}
                aria-label={t("agentMode.input.send")}
                className={cn(
                  "rounded-full shrink-0",
                  rowCenter,
                  voiceDraft && "animate-[scale-in_0.15s_ease-out_backwards]",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-all duration-100",
                  inputText.trim()
                    ? "hover:brightness-110 active:scale-95"
                    : hasRoundSend
                      ? "cursor-default"
                      : "opacity-30 saturate-0 cursor-default"
                )}
              >
                {hasRoundSend ? (
                  <span
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full",
                      inputText.trim() ? GRADIENT_CIRCLE : "bg-muted text-muted-foreground"
                    )}
                  >
                    <ArrowRight size={18} className="-rotate-90" />
                  </span>
                ) : (
                  <SendIcon size={28} className="block rtl:scale-x-[-1]" />
                )}
              </button>
            ) : isIdle ? (
              <button
                key="mic"
                onClick={voice.start}
                disabled={voice.streamingOnlyProvider}
                aria-label={t("notes.editor.transcribe")}
                title={
                  voice.streamingOnlyProvider
                    ? t("agentMode.input.voiceDraftStreamingOnly")
                    : t("notes.editor.transcribe")
                }
                className={cn(
                  "flex items-center justify-center rounded-full shrink-0",
                  hasRoundSend ? "size-8" : cn("w-7 h-7", expandOnFocus && COLLAPSED_ROW_CENTER),
                  rowCenter,
                  "animate-[scale-in_0.15s_ease-out_backwards]",
                  GRADIENT_CIRCLE,
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
                  "transition-all duration-100",
                  voice.streamingOnlyProvider
                    ? "opacity-30 saturate-0 cursor-default"
                    : "hover:brightness-110 active:scale-95"
                )}
              >
                <Mic size={hasRoundSend ? 16 : 14} />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
