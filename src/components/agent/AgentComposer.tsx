import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft, Mic, Square, X } from "../icons";
import { cn } from "../lib/utils";
import { ICON_BUTTON } from "../chat/interactions/cardStyles";

interface AgentComposerProps {
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: (text: string) => void;
  placeholder: string;
  /** A reply is being written: Send waits, and Stop ends it. */
  busy: boolean;
  /** The reply waits on a question the text can answer, so Send works meanwhile. */
  answering?: boolean;
  /** Absent while a card waits on the user or sends: the card carries the turn then. */
  onStop?: () => void;
  /** In the modal the composer carries Close and Mic; above the pill they are the pill's. */
  onClose?: () => void;
  onMic?: () => void;
  /** A take is still transcribing, or a reply is running. */
  micDisabled: boolean;
  /** Voice input is unavailable with this transcription provider. */
  micUnavailableHint?: string;
  /** Takes the keyboard once the window has it. */
  focused: boolean;
  /** Rides above the text (the selected context it will be sent with). */
  header?: ReactNode;
  className?: string;
}

/** The agent's typed input: the draft, with Close and Mic on the left and Send (or Stop) on the right. */
export function AgentComposer({
  draft,
  onDraftChange,
  onSubmit,
  placeholder,
  busy,
  answering = false,
  onStop,
  onClose,
  onMic,
  micDisabled,
  micUnavailableHint,
  focused,
  header,
  className,
}: AgentComposerProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canSend = (answering || !busy) && draft.trim().length > 0;

  useEffect(() => {
    if (!focused) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [focused]);

  const submit = () => {
    if (!canSend) return;
    onSubmit(draft.trim());
  };

  return (
    <div
      className={cn(
        "flex flex-col rounded-[22px] border border-border bg-surface-1 px-3 pt-3 pb-2 shadow-[var(--shadow-card)]",
        className
      )}
    >
      {header}
      {/* As tall as the draft, up to six lines, then it scrolls; never under one line. */}
      <textarea
        ref={inputRef}
        dir="auto"
        rows={1}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="input-inline field-sizing-content max-h-36 min-h-6 flex-1 resize-none border-0 bg-transparent px-1 text-base leading-6 text-foreground caret-primary outline-none placeholder:text-muted-foreground/70"
      />
      {micUnavailableHint && (
        <p className="px-1 pb-1 text-[11px] text-muted-foreground">{micUnavailableHint}</p>
      )}
      <div className="flex items-center gap-2 pt-1">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("agentWindow.actions.close")}
            title={t("agentWindow.actions.close")}
            className={ICON_BUTTON}
          >
            <X size={16} />
          </button>
        )}
        <div className="ms-auto flex items-center gap-2">
          {onMic && (
            <button
              type="button"
              onClick={onMic}
              disabled={micDisabled || Boolean(micUnavailableHint)}
              aria-label={t("agentWindow.actions.speak")}
              title={micUnavailableHint ?? t("agentWindow.actions.speak")}
              className={ICON_BUTTON}
            >
              <Mic size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label={t("agentMode.input.send")}
            title={t("agentMode.input.send")}
            className="flex h-6 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[filter,opacity] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40 disabled:hover:brightness-100"
          >
            <CornerDownLeft size={16} className="rtl:scale-x-[-1]" />
          </button>
          {busy && onStop && (
            <button
              type="button"
              onClick={onStop}
              aria-label={t("agentWindow.actions.stop")}
              title={t("agentWindow.actions.stop")}
              className={cn(
                ICON_BUTTON,
                "bg-foreground/10 text-foreground hover:bg-foreground/15 dark:bg-surface-2 dark:hover:bg-surface-raised"
              )}
            >
              <Square size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
