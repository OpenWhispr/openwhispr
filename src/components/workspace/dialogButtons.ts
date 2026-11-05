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
