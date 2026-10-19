// Shared by the interaction cards and the answer cards' connect prompt.

/** A round icon button: the dismiss X, the ↑ submit. */
export const ROUND_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 disabled:opacity-40 disabled:hover:bg-surface-2";

/** A small pill action: Yes, Not now, Continue, Copy. */
export const PILL_BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-surface-2 px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-surface-raised focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 disabled:opacity-50 disabled:hover:bg-surface-2";

/** The card's main action: Allow, Send. */
export const PRIMARY_PILL_BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-[filter,opacity] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 disabled:hover:brightness-100";

/** A text field inside a card: the typed answer, the API key. */
export const CARD_FIELD =
  "h-8 min-w-0 flex-1 rounded-full bg-surface-2 px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring/40";
