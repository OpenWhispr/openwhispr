import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "../icons";
import { cn } from "../lib/utils";

const RECORDING_SURFACE = "bg-surface-2/95 shadow-(--shadow-glass)";

interface NoteBottomBarProps {
  /** Uses an opaque surface while the live transcript streams underneath. */
  isRecording: boolean;
  onAskSubmit: (text: string) => void;
  onInputFocus?: () => void;
  askDisabled?: boolean;
  actionPicker?: React.ReactNode;
  /** One centred call to action floated above the ask capsule. */
  callout?: React.ReactNode;
  hideInput?: boolean;
}

export default function NoteBottomBar({
  isRecording,
  onAskSubmit,
  onInputFocus,
  askDisabled,
  actionPicker,
  callout,
  hideInput,
}: NoteBottomBarProps) {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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

  // Chat panel opening hides the input; drop the expanded state so the bar
  // comes back in its idle layout when the panel closes.
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
      className="absolute bottom-0 left-0 right-0 z-10 px-5 pb-7 pt-6 pointer-events-none bg-gradient-to-t from-background from-45% to-transparent"
    >
      {callout && !hideInput && (
        <div className="pointer-events-auto mb-3 flex justify-center">{callout}</div>
      )}
      <div className="flex items-end pointer-events-auto w-full max-w-[600px] mx-auto">
        <div
          aria-hidden={hideInput}
          className={cn(
            "flex-1 min-w-0 flex items-center h-12 gap-2 rounded-full",
            isRecording ? RECORDING_SURFACE : "bg-background shadow-sm",
            "border",
            "transition-[max-width,opacity,padding,border-color,box-shadow] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
            hideInput
              ? "max-w-0 opacity-0 ps-0 pe-0 border-transparent shadow-none pointer-events-none"
              : "max-w-[600px] opacity-100 ps-4 pe-2",
            isExpanded
              ? "border-black/15 dark:border-white/22 ring-[3px] ring-primary/8"
              : !hideInput && "border-black/10 dark:border-white/14"
          )}
        >
          <input
            dir="auto"
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={handleInputFocus}
            disabled={askDisabled}
            tabIndex={hideInput ? -1 : undefined}
            placeholder={t("chat.inputPlaceholder")}
            className={cn(
              "input-inline flex-1 bg-transparent outline-none min-w-0 p-0 caret-primary",
              "text-sm text-foreground",
              "placeholder:text-muted-foreground"
            )}
          />

          {!hasText && !isExpanded && actionPicker && (
            <div className="shrink-0">{actionPicker}</div>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!hasText || askDisabled}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
              "transition-colors duration-150",
              "enabled:hover:bg-muted/80 enabled:hover:text-foreground enabled:active:scale-95",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              "disabled:cursor-default"
            )}
            aria-label={t("embeddedChat.send")}
          >
            <ArrowRight size={18} className="-rotate-90" />
          </button>
        </div>
      </div>
    </div>
  );
}
