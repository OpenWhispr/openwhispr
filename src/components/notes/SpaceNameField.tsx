import { useTranslation } from "react-i18next";
import { useState, type Ref } from "react";
import { Smile } from "../icons";
import { Popover, PopoverTrigger } from "../ui/popover";
import { EmojiPickerContent } from "../ui/EmojiPicker";
import { cn } from "../lib/utils";

// Two borderless boxes side by side, as the design draws them: the emoji tile's own 38px box and
// the name's field. `input-inline` keeps the global input rules in index.css off the input.
const BOX_CLASS =
  "flex h-[38px] items-center rounded-xl bg-surface-1 ring-1 ring-inset ring-black/[0.06] dark:bg-surface-window dark:ring-0";
const BOX_EDITABLE_CLASS =
  "transition-shadow duration-200 focus-within:ring-2 focus-within:ring-ring/40 dark:focus-within:ring-2";

const TILE_CLASS = "flex size-[38px] shrink-0 items-center justify-center rounded-xl";
const TILE_EDITABLE_CLASS =
  "outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary/20 " +
  "data-[state=open]:bg-foreground/10 dark:hover:bg-white/10 dark:data-[state=open]:bg-white/10";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function initialOf(name: string): string | null {
  for (const { segment } of graphemes.segment(name.trim())) return segment.toLocaleUpperCase();
  return null;
}

// Also the tile in the Settings Teamspaces table, so a row and this field draw a teamspace alike.
export function TileGlyph({ emoji, name }: { emoji: string | null; name: string }) {
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
  /** Marks the name as the field a form error is about, with `describedBy` naming that error. */
  invalid?: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
  onBlur?: () => void;
  onEnter?: () => void;
}

// A space's emoji tile and its name, in two boxes. The tile opens the emoji picker and falls back
// to the name's initial when no emoji is set.
export default function SpaceNameField({
  id,
  name,
  emoji,
  onNameChange,
  onEmojiChange,
  readOnly = false,
  autoFocus,
  invalid = false,
  describedBy,
  inputRef,
  onBlur,
  onEnter,
}: SpaceNameFieldProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);

  const invalidClass =
    "ring-2 ring-destructive/40 focus-within:ring-destructive/50 dark:ring-2";

  return (
    <div className="flex items-center gap-2">
      {readOnly ? (
        <span className={cn(BOX_CLASS, TILE_CLASS)} aria-hidden="true">
          <TileGlyph emoji={emoji} name={name} />
        </span>
      ) : (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("notes.spaces.changeEmoji")}
              title={t("notes.spaces.changeEmoji")}
              className={cn(BOX_CLASS, TILE_CLASS, TILE_EDITABLE_CLASS)}
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
      <div
        className={cn(
          BOX_CLASS,
          "min-w-0 flex-1",
          !readOnly && BOX_EDITABLE_CLASS,
          invalid && invalidClass
        )}
      >
        <input
          dir="auto"
          id={id}
          type="text"
          value={name}
          ref={inputRef}
          autoFocus={autoFocus}
          maxLength={80}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          readOnly={readOnly}
          tabIndex={readOnly ? -1 : undefined}
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) onEnter?.();
          }}
          className={cn(
            "input-inline h-full min-w-0 flex-1 bg-transparent px-3 text-base text-foreground outline-none placeholder:text-muted-foreground/70",
            readOnly && "cursor-default caret-transparent text-foreground/70"
          )}
        />
      </div>
    </div>
  );
}
