// The class tokens the workspace settings tables share, so a table and its loading and failed
// frames look alike across People and Teamspaces.
export const TABLE_FRAME = "rounded-xl border border-border/70 dark:border-border-subtle/70";
export const ROW_DIVIDER = "border-t border-border/60 dark:border-border-subtle/50";
// The header sticks over the rows on the settings pane's own background.
export const HEADER_CELL =
  "sticky top-0 z-10 h-9 bg-background dark:bg-surface-1 text-xs font-normal text-muted-foreground first:rounded-ss-xl last:rounded-se-xl";
// The tile before a row's name, and the button of a cell that opens a list (admins, members,
// teamspaces), so the tables beside each other read the same.
export const NAME_TILE =
  "flex size-7 shrink-0 items-center justify-center rounded-sm bg-foreground/5 dark:bg-white/6";
export const CONTACTS_TRIGGER =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border/70 px-2 text-xs text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-primary/30 data-[state=open]:bg-foreground/5 dark:border-border-subtle/70 dark:hover:bg-white/5";
