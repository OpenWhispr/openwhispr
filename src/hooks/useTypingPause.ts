import { useState } from "react";
import { CONNECTION_CHECK_DELAY_MS } from "./useConnectionAutoCheck";

export interface TypingPauseInputs {
  /** The credential strings a user types for this check. */
  typed: string;
  /** Everything else the check depends on, as one string (e.g. a JSON array). */
  context: string;
  /** Focus is inside the panel's credential fields. */
  held: boolean;
}

/**
 * The pause before a panel's check. A change to a typed credential waits
 * CONNECTION_CHECK_DELAY_MS, wherever it was typed: hosted keys are shared, so another shown
 * panel may be typing this one's key. Leaving the panel's fields, showing the panel, or any
 * other change to the check (a tab, a model, a region) checks at once.
 */
export function useTypingPause({ typed, context, held }: TypingPauseInputs): number {
  const [tracked, setTracked] = useState({ typed, context, held, pause: false });
  if (tracked.typed !== typed || tracked.context !== context || tracked.held !== held) {
    // A context change wins over a typed change in the same render: a tab switch shows
    // another provider's key, which is not being typed. So does the hold's drop: a keystroke
    // never coincides with leaving the fields, only a value tidied and saved on blur does.
    const pause =
      tracked.context !== context
        ? false
        : tracked.held && !held
          ? false
          : tracked.typed !== typed
            ? true
            : tracked.pause;
    setTracked({ typed, context, held, pause });
  }
  // `held` on its own keeps the pause too: focus moving between two field groups wired to
  // the same hold drops and restores it within one task, before any 0 ms timer can fire.
  return held || tracked.pause ? CONNECTION_CHECK_DELAY_MS : 0;
}
