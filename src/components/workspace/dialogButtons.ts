import { cn } from "../lib/utils";

// The footer buttons the workspace dialogs share: two equal capsules.
const BUTTON_BASE =
  "flex h-[38px] flex-1 items-center justify-center gap-2 rounded-full px-4 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";
export const PRIMARY_BUTTON = cn(
  BUTTON_BASE,
  "bg-primary text-primary-foreground hover:bg-primary/90"
);
export const SECONDARY_BUTTON = cn(
  BUTTON_BASE,
  "bg-surface-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
);

// A dialog's form fields, as the design draws them: a 14px muted label 12px above a borderless
// 38px field on a darker surface, with 16px text. `input-inline` keeps the global input rules in
// index.css (a border and a fill) off it, so these classes decide the look.
export const FIELD_LABEL = "text-sm font-medium text-muted-foreground";
export const FIELD_GROUP = "flex flex-col gap-3";
export const FIELD_CONTROL =
  "input-inline h-[38px] w-full min-w-0 rounded-xl bg-surface-1 px-3 text-base text-foreground outline-none ring-1 ring-inset ring-black/[0.06] transition-shadow " +
  "placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-surface-window dark:ring-0 dark:focus-visible:ring-2 " +
  "aria-invalid:ring-2 aria-invalid:ring-destructive/40 disabled:cursor-not-allowed disabled:opacity-50";
export const FIELD_AREA = cn(FIELD_CONTROL, "h-auto min-h-[94px] resize-none py-2.5");

// A dialog's picker (the new owner): a rounded box with an up/down chevron, drawn on the card or
// dialog around it.
export const PICKER_TRIGGER =
  "flex min-h-[38px] w-full items-center gap-2.5 rounded-xl bg-surface-1 px-3 py-1.5 text-start text-sm text-foreground outline-none ring-1 ring-inset ring-black/[0.06] transition-colors " +
  "hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-surface-window dark:ring-0 dark:hover:bg-surface-1";

// The raised pill the design fills with surface-3: the active tab, the selection count and the bar's
// buttons. The light theme's surface-3 is paler than the design's, so light mode darkens instead.
export const RAISED_PILL = "bg-black/[0.07] dark:bg-surface-raised";

// The empty state's Create: a 34px raised pill, as the design draws it.
const PILL_ACTION =
  "inline-flex h-[34px] items-center gap-1.5 rounded-full text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 " +
  RAISED_PILL;
export const EMPTY_CREATE_BUTTON = cn(PILL_ACTION, "ps-3.5 pe-4");
// A table's Try again, with no icon.
export const STATE_ACTION_BUTTON = cn(PILL_ACTION, "px-4");

// A split pill (label | chevron), as the design draws Add and Add to team. The surface is the
// caller's: Add sits on the page, Add to team on the selection bar.
export const SPLIT_PILL =
  "inline-flex h-[34px] shrink-0 items-center rounded-full text-muted-foreground";
const SPLIT_PILL_PART =
  "inline-flex h-full items-center text-xs font-medium outline-none transition-colors hover:bg-foreground/5 hover:text-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground";
export const SPLIT_PILL_LABEL = cn(SPLIT_PILL_PART, "gap-1.5 rounded-s-full ps-4 pe-2");
export const SPLIT_PILL_CHEVRON = cn(
  SPLIT_PILL_PART,
  "rounded-e-full border-s border-border ps-2.5 pe-3 dark:border-border-subtle"
);

// The settings dialogs' tab triggers, inline-edited header fields and General-row pills.
export const TAB_TRIGGER_CLASS = "h-[26px] gap-1 rounded-full px-2 py-0 text-xs";
export const TABS_LIST_CLASS = "h-[34px] gap-2 rounded-full p-1";

// The header's name and description read as plain text until focused, as in the frame, so an
// admin's field only shows itself when it's in use. The padding is pulled back out with a
// negative margin, so the text lines up with the tile above it.
export const INLINE_FIELD_CLASS =
  "input-inline -mx-1.5 block w-[calc(100%+0.75rem)] min-w-0 resize-none rounded-md bg-transparent px-1.5 outline-none " +
  "transition-colors hover:bg-foreground/5 focus:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/15";

export const ROW_BUTTON_CLASS =
  "inline-flex h-[26px] shrink-0 items-center justify-center rounded-full px-2.5 text-xs font-medium transition-colors " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
  "disabled:pointer-events-none disabled:opacity-50";

// The card a settings dialog's General panel keeps its rows in, as the design draws it: an 8px inset,
// rows 16px apart with a hairline halfway between them, the full width of the card's contents.
export const SETTING_ROWS =
  "flex flex-col gap-4 rounded-xl bg-surface-1 p-2 [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-0 [&>*+*]:before:-top-2 [&>*+*]:before:h-px [&>*+*]:before:bg-border/60";
