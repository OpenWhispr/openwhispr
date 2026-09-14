import { useTranslation } from "react-i18next";
import { useState, type Ref } from "react";
import { Smile } from "../icons";
import { Popover, PopoverTrigger } from "../ui/popover";
import { EmojiPickerContent } from "../ui/EmojiPicker";
import { cn } from "../lib/utils";

// Mirrors the rendered chrome of Input, which the global input rules in
// index.css paint white (dark: --color-input) with an active border and a
// 15% ring on focus.
const FIELD_CLASS =
  "flex h-10 w-full items-center rounded border border-border bg-background px-1 dark:bg-input";
const FIELD_EDITABLE_CLASS =
  "transition-[border-color,box-shadow] duration-200 focus-within:border-border-active focus-within:ring-2 focus-within:ring-ring/15";

const TILE_CLASS =
  "flex size-8 shrink-0 items-center justify-center rounded-sm bg-foreground/5 dark:bg-white/6";
const TILE_EDITABLE_CLASS =
  "outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary/20 " +
  "data-[state=open]:bg-foreground/10 dark:hover:bg-white/10 dark:data-[state=open]:bg-white/10";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function initialOf(name: string): string | null {
  for (const { segment } of graphemes.segment(name.trim())) return segment.toLocaleUpperCase();
  return null;
}

function TileGlyph({ emoji, name }: { emoji: string | null; name: string }) {
  if (emoji) return <span className="font-emoji text-lg leading-none">{emoji}</span>;
  const initial = initialOf(name);
  if (initial) return <span className="text-sm font-medium text-foreground/70">{initial}</span>;
  return <Smile size={16} className="text-muted-foreground/60" />;
}

interface SpaceNameFieldProps {
  id?: string;
  name: string;
  emoji: string | null;
  onNameChange: (name: string) => void;
  onEmojiChange: (emoji: string | null) => void;
  /** Presents the current values without editing affordances. */
  readOnly?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onBlur?: () => void;
  onEnter?: () => void;
}

// One bordered field holding a space's emoji tile and its name. The tile opens
// the emoji picker and falls back to the name's initial when no emoji is set.
export default function SpaceNameField({
  id,
  name,
  emoji,
  onNameChange,
  onEmojiChange,
  readOnly = false,
  autoFocus,
  inputRef,
  onBlur,
  onEnter,
}: SpaceNameFieldProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className={cn(FIELD_CLASS, !readOnly && FIELD_EDITABLE_CLASS)}>
      {readOnly ? (
        <span className={TILE_CLASS} aria-hidden="true">
          <TileGlyph emoji={emoji} name={name} />
        </span>
      ) : (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("notes.spaces.changeEmoji")}
              title={t("notes.spaces.changeEmoji")}
              className={cn(TILE_CLASS, TILE_EDITABLE_CLASS)}
            >
              <TileGlyph emoji={emoji} name={name} />
            </button>
          </PopoverTrigger>
          <EmojiPickerContent
            value={emoji}
            onSelect={(next) => {
              onEmojiChange(next);
              setPickerOpen(false);
            }}
          />
        </Popover>
      )}
      <input
        dir="auto"
        id={id}
        type="text"
        value={name}
        ref={inputRef}
        autoFocus={autoFocus}
        maxLength={80}
        readOnly={readOnly}
        tabIndex={readOnly ? -1 : undefined}
        onChange={(event) => onNameChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) onEnter?.();
        }}
        className={cn(
          "input-inline h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70",
          readOnly && "cursor-default caret-transparent text-foreground/70"
        )}
      />
    </div>
  );
}
