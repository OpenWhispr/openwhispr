import { cn } from "../../lib/utils";

// Shared by the interaction cards and the answer cards.

/** A round icon button: the dismiss X, the ↑ submit. */
export const ROUND_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-primary text-secondary transition-colors hover:bg-surface-tertiary hover:text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-focus/40 disabled:opacity-40 disabled:hover:bg-surface-primary";

/** A borderless round icon button: the composer's Close and Mic, a question card's ‹ ›. */
export const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-text-primary/10 hover:text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-focus/40 disabled:opacity-40 disabled:hover:bg-transparent";

/** A small pill action: Yes, Not now, Continue, Copy. */
export const PILL_BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-surface-primary px-3 text-[13px] font-medium text-primary transition-colors hover:bg-surface-tertiary focus:outline-none focus-visible:ring-1 focus-visible:ring-focus/40 disabled:opacity-50 disabled:hover:bg-surface-primary agent:text-[14px]";

/** The card's main action: Allow, Send. */
export const PRIMARY_PILL_BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-brand-solid px-3.5 text-[13px] font-medium text-on-solid transition-[filter,opacity] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-50 disabled:hover:brightness-100 agent:text-[14px]";

// input-inline opts the card's fields out of the app's global field styles.

/** A field an answer card edits in place: it reads like the text it holds until focused. */
export const INLINE_FIELD =
  "input-inline -mx-1 min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-primary outline-none hover:bg-text-primary/5 focus-visible:bg-text-primary/5 focus-visible:ring-1 focus-visible:ring-focus/40 aria-invalid:ring-1 aria-invalid:ring-red-solid/60";

/**
 * A text field inside a card: the typed answer, the API key. In the agent
 * window, as in its composer, the caret alone shows it has focus.
 */
export const CARD_FIELD =
  "input-inline h-8 min-w-0 flex-1 rounded-full bg-surface-primary px-3 text-[13px] text-primary outline-none placeholder:text-secondary/70 focus-visible:ring-1 focus-visible:ring-focus/40 agent:text-[15px] agent:focus-visible:ring-0";

/** A card's title, edited in place across the card. */
export const INLINE_TITLE_FIELD = cn(INLINE_FIELD, "mb-1 block w-[calc(100%+0.5rem)] font-medium");

/** A card's message, edited in place across the card and as tall as its text. */
export const INLINE_TEXT_FIELD = cn(
  INLINE_FIELD,
  "field-sizing-content block w-[calc(100%+0.5rem)] resize-none leading-6 agent:leading-snug"
);
