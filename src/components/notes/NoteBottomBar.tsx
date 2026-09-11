import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { SendIcon } from "../ui/SendIcon";
import { GLASS_SURFACE } from "../ui/glass";

// While recording, the bar sits over the live streaming transcript, and every
// partial would force backdrop-blur to re-blur the strip; the capsule trades
// glass for a near-opaque surface until the recording ends.
const RECORDING_SURFACE = "bg-surface-2/95 shadow-(--shadow-glass)";

interface NoteBottomBarProps {
  /** Swaps the glass surface for an opaque one while the live transcript streams underneath. */
  isRecording: boolean;
  onAskSubmit: (text: string) => void;
  onInputFocus?: () => void;
  askDisabled?: boolean;
  actionPicker?: React.ReactNode;
  hideInput?: boolean;
}

export default function NoteBottomBar({
  isRecording,
  onAskSubmit,
  onInputFocus,
  askDisabled,
  actionPicker,
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
      className="absolute bottom-0 left-0 right-0 z-10 px-5 pb-4 pt-6 pointer-events-none bg-gradient-to-t from-background from-45% to-transparent"
    >
      <div className="flex items-end pointer-events-auto w-full max-w-[600px] mx-auto">
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
              ? "max-w-0 opacity-0 ps-0 pe-0 border-transparent shadow-none pointer-events-none"
              : "max-w-[600px] opacity-100 ps-4 pe-1.5",
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
            placeholder={t("embeddedChat.askPlaceholder")}
            className={cn(
              "input-inline flex-1 bg-transparent outline-none min-w-0 p-0 caret-primary",
              "text-[13px] text-foreground",
              "placeholder:text-foreground/45 dark:placeholder:text-foreground/45"
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
              <SendIcon size={28} className="block rtl:scale-x-[-1]" />
            </button>
          ) : !isExpanded ? (
            <div className="shrink-0">{actionPicker}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
