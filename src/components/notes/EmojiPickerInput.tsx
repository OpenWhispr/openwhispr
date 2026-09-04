import { useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Input } from "../ui/input";
import { clampEmojiInput } from "../../lib/emojiInput";
import { cn } from "../lib/utils";

const EMOJI_CHOICES = [
  "📝",
  "📋",
  "💡",
  "🚀",
  "🎯",
  "📣",
  "🛠️",
  "🎨",
  "📊",
  "💼",
  "🤝",
  "🌱",
  "🔬",
  "🧪",
  "📚",
  "✨",
  "🔥",
  "⭐",
  "💬",
  "🗂️",
  "🧭",
  "🌍",
  "🔒",
  "🏆",
];

interface EmojiPickerInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  autoFocus?: boolean;
  /**
   * The grid renders in a portal, so focus leaves the host's DOM subtree while
   * it is open — inline-edit hosts that commit on blur-outside use this to
   * suppress the commit until the picker closes.
   */
  onPickerOpenChange?: (open: boolean) => void;
}

// Emoji field with the OS emoji panel where one exists (macOS) and a 24-emoji
// grid fallback (Linux, or when the panel can't be shown).
export function EmojiPickerInput({
  id,
  value,
  onChange,
  ariaLabel,
  className,
  autoFocus,
  onPickerOpenChange,
}: EmojiPickerInputProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const setOpen = (open: boolean): void => {
    setPickerOpen(open);
    onPickerOpenChange?.(open);
  };

  const openPicker = async (): Promise<void> => {
    const nativeShown = await window.electronAPI?.showEmojiPanel?.().catch(() => false);
    if (!nativeShown) setOpen(true);
  };

  return (
    <Popover open={pickerOpen} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          id={id}
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(clampEmojiInput(e.target.value))}
          onClick={() => void openPicker()}
          aria-label={ariaLabel}
          className={cn("text-center", className)}
        />
      </PopoverAnchor>
      <PopoverContent
        className="w-auto min-w-0 p-1.5"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (e.target === inputRef.current) e.preventDefault();
        }}
      >
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJI_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => {
                onChange(choice === value ? "" : choice);
                setOpen(false);
                inputRef.current?.focus();
              }}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md text-base outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                choice === value && "bg-accent"
              )}
            >
              {choice}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
