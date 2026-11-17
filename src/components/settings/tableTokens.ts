// The class tokens the workspace settings tables share, so a table and its loading and failed
// frames look alike across People and Teamspaces.
export const TABLE_FRAME = "rounded-xl border border-border/70 dark:border-border-subtle/70";
export const ROW_DIVIDER = "border-t border-border/60 dark:border-border-subtle/50";
// The header sticks over the rows on a surface of its own, as the design draws it.
export const HEADER_CELL =
  "sticky top-0 z-10 h-9 bg-surface-1 text-sm font-normal text-muted-foreground first:rounded-ss-xl last:rounded-se-xl";
// The tile before a row's name, and the button of a cell that opens a list (admins, members,
// teamspaces), so the tables beside each other read the same.
export const NAME_TILE =
  "flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-foreground/5 dark:bg-white/6 [&>span]:text-xs [&>span.font-emoji]:text-sm";
// The 1px line between columns, as the design draws it on every table.
export const COLUMN_DIVIDER = "border-s border-border/60 dark:border-border-subtle/50";
// A cell's list trigger drawn as plain text with a chevron (Actions, "3 notes"), filled on hover.
export const PLAIN_MENU_TRIGGER =
  "inline-flex h-7 max-w-full items-center gap-1 rounded-lg px-1.5 text-sm text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-primary/30 data-[state=open]:bg-foreground/5 dark:hover:bg-white/5";
export const CONTACTS_TRIGGER =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border/70 px-2 text-xs text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-primary/30 data-[state=open]:bg-foreground/5 dark:border-border-subtle/70 dark:hover:bg-white/5";

// A workspace settings page's own title and description, as the design sets them (People,
// Teamspaces, General, Developer).
export const PAGE_TITLE = "text-lg font-medium leading-[1.4] text-foreground";
export const PAGE_DESCRIPTION = "mt-1 text-sm text-muted-foreground";
