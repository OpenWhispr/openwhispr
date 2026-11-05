import { cn } from "../lib/utils";

// The footer buttons the workspace dialogs share: two equal capsules.
export const BUTTON_BASE =
  "flex h-10 flex-1 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";
export const PRIMARY_BUTTON = cn(
  BUTTON_BASE,
  "bg-primary text-primary-foreground hover:bg-primary/90"
);
export const SECONDARY_BUTTON = cn(
  BUTTON_BASE,
  "bg-surface-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
);

// The settings dialogs' tab triggers, inline-edited header fields and General-row pills.
export const TAB_TRIGGER_CLASS = "h-6 gap-1.5 px-2.5 text-xs rounded-[5px]";

// The header's name and description read as plain text until focused, as in the frame, so an
// admin's field only shows itself when it's in use. The padding is pulled back out with a
// negative margin, so the text lines up with the tile above it.
export const INLINE_FIELD_CLASS =
  "input-inline -mx-1.5 block w-[calc(100%+0.75rem)] min-w-0 resize-none rounded-md bg-transparent px-1.5 outline-none " +
  "transition-colors hover:bg-foreground/5 focus:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/15";

export const ROW_BUTTON_CLASS =
  "inline-flex h-7 shrink-0 items-center justify-center rounded-full px-3 text-xs font-medium transition-colors " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
  "disabled:pointer-events-none disabled:opacity-50";
